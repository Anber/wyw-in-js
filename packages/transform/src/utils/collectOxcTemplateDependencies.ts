/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { ExpressionValue, Location } from '@wyw-in-js/shared';
import { ValueType } from '@wyw-in-js/shared';
import type {
  AssignmentExpression,
  Expression,
  Node,
  Program,
  TemplateLiteral,
  UpdateExpression,
  VariableDeclaration,
  VariableDeclarator,
} from 'oxc-parser';

import { parseOxcProgramCached } from './parseOxc';

type AnyNode = Node & Record<string, unknown>;
type OxcFunctionLikeNode = Node & {
  async: boolean;
  body: Node | null;
  id?: { name: string } | null;
  params: Node[];
};
type BindingKind = 'function' | 'import' | 'param' | 'variable';
type ScopedDeclarationKind = 'const' | 'let' | 'var';

type Binding = {
  declarationKind?: ScopedDeclarationKind;
  declaredAt: number;
  declaration: VariableDeclaration | null;
  declarator: VariableDeclarator | null;
  functionNode?: OxcFunctionLikeNode | null;
  importedFrom?: string;
  isRoot: boolean;
  kind: BindingKind;
  name: string;
  scope: Scope;
};

type Replacement = {
  end: number;
  start: number;
  value: string;
};

type SourceLocation = {
  end: Location;
  filename?: string;
  identifierName: string | null | undefined;
  start: Location;
};

type SpanLookup = Set<string> | null;

type LocationLookup = (offset: number) => Location;

type ExpressionSpan = {
  end: number;
  start: number;
};

type Scope = {
  bindings: Map<string, Binding>;
  depth: number;
  end: number;
  functionBoundary: boolean;
  params: Set<string>;
  parent: Scope | null;
  root: boolean;
  start: number;
};

type ReferenceIdentifier = {
  end: number;
  name: string;
  start: number;
};

type TemplateExtractionResult = {
  code: string;
  dependencyNames: string[];
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[];
};

type ExtractionContext = {
  bindingResolutionCache: Map<string, Map<number, Binding | null>>;
  bindingsByName: Map<string, Binding[]>;
  code: string;
  currentInsertionPoint: number;
  currentExpressionStart: number;
  dependencyNames: Set<string>;
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[];
  filename: string;
  hoistedDeclarations: Map<string, string>;
  hoistedDeclarationsByInsertionPoint: Map<number, string[]>;
  loc: LocationLookup;
  referencesByNode: WeakMap<Node, ReferenceIdentifier[]>;
  removedDeclarations: Set<VariableDeclaration>;
  replacements: Replacement[];
  rootMutationsByBinding: Map<string, Array<AssignmentExpression | UpdateExpression>>;
  usedNames: Set<string>;
};

type ExtractedExpression = {
  expressionCode: string;
  importedFrom: string[];
  kind: ValueType.FUNCTION | ValueType.LAZY;
};

type ProgramAnalysis = {
  bindingsByName: Map<string, Binding[]>;
  rootMutationsByBinding: Map<string, Array<AssignmentExpression | UpdateExpression>>;
  targetExpressions: Expression[];
  templateLiterals: TemplateLiteral[];
  usedNames: Set<string>;
};

const isNode = (value: unknown): value is Node =>
  !!value &&
  typeof value === 'object' &&
  'type' in value &&
  typeof (value as { type?: unknown }).type === 'string';

const getChildren = (node: Node): Node[] => {
  const result: Node[] = [];
  const record = node as AnyNode;

  Object.keys(record).forEach((key) => {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range') {
      return;
    }

    const value = record[key];
    if (isNode(value)) {
      result.push(value);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (isNode(item)) {
          result.push(item);
        }
      });
    }
  });

  return result;
};

const parseOxc = (code: string, filename: string): Program => {
  return parseOxcProgramCached(filename, code, 'unambiguous');
};

const toSpanKey = (start: number, end: number): string => `${start}:${end}`;

const createSpanLookup = (spans?: ExpressionSpan[]): SpanLookup => {
  if (!spans || spans.length === 0) {
    return null;
  }

  return new Set(spans.map((span) => toSpanKey(span.start, span.end)));
};

const matchesSpanLookup = (
  node: Pick<Node, 'start' | 'end'>,
  spanLookup: SpanLookup
): boolean => !spanLookup || spanLookup.has(toSpanKey(node.start, node.end));

const createLocationLookup = (code: string): LocationLookup => {
  const lineStarts = [0];
  for (let idx = 0; idx < code.length; idx += 1) {
    if (code[idx] === '\n') {
      lineStarts.push(idx + 1);
    }
  }

  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const next = lineStarts[mid + 1] ?? Infinity;
      if (lineStarts[mid] <= offset && offset < next) {
        return {
          column: offset - lineStarts[mid],
          line: mid + 1,
        };
      }

      if (offset < lineStarts[mid]) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    const lastLine = lineStarts.length - 1;
    return {
      column: Math.max(0, offset - lineStarts[lastLine]),
      line: lastLine + 1,
    };
  };
};

const getSourceLocation = (
  start: number,
  end: number,
  ctx: Pick<ExtractionContext, 'filename' | 'loc'>
): SourceLocation => ({
  end: ctx.loc(end),
  filename: ctx.filename,
  identifierName: undefined,
  start: ctx.loc(start),
});

const createScope = (
  parent: Scope | null,
  node: Pick<Node, 'start' | 'end'>,
  root = false,
  functionBoundary = false
): Scope => ({
  bindings: new Map(),
  depth: parent ? parent.depth + 1 : 0,
  end: node.end,
  functionBoundary,
  params: new Set(),
  parent,
  root,
  start: node.start,
});

const normalizeDeclarationKind = (
  declarationKind: VariableDeclaration['kind']
): ScopedDeclarationKind => {
  if (declarationKind === 'var') {
    return 'var';
  }

  if (declarationKind === 'let') {
    return 'let';
  }

  return 'const';
};

const getDeclarationScope = (
  scope: Scope,
  declarationKind: ScopedDeclarationKind
): Scope => {
  if (declarationKind !== 'var') {
    return scope;
  }

  let current: Scope | null = scope;
  while (current && !current.functionBoundary) {
    current = current.parent;
  }

  return current ?? scope;
};

const collectBindingNames = (node: Node): string[] => {
  if (node.type === 'Identifier') {
    return [node.name];
  }

  if (node.type === 'RestElement') {
    return collectBindingNames(node.argument);
  }

  if (node.type === 'AssignmentPattern') {
    return collectBindingNames(node.left);
  }

  if (node.type === 'ObjectPattern') {
    return node.properties.flatMap((property) =>
      property.type === 'RestElement'
        ? collectBindingNames(property.argument)
        : collectBindingNames(property.value)
    );
  }

  if (node.type === 'ArrayPattern') {
    return node.elements.flatMap((element) =>
      element ? collectBindingNames(element) : []
    );
  }

  if (node.type === 'TSParameterProperty') {
    return collectBindingNames(node.parameter);
  }

  return [];
};

const isInTypeContext = (ancestors: Node[]): boolean =>
  ancestors.some(
    (ancestor) =>
      ancestor.type.startsWith('TS') || ancestor.type.startsWith('JSDoc')
  );

const isPropertyOnlyIdentifier = (node: Node, parent: Node | null): boolean =>
  !!parent &&
  parent.type === 'MemberExpression' &&
  parent.property === node &&
  !parent.computed;

const isObjectPropertyKey = (node: Node, parent: Node | null): boolean =>
  !!parent &&
  parent.type === 'Property' &&
  parent.key === node &&
  !parent.computed &&
  parent.value !== node;

const isBindingPosition = (node: Node, parent: Node | null): boolean => {
  if (!parent) {
    return false;
  }

  if (parent.type === 'VariableDeclarator' && parent.id === node) {
    return true;
  }

  if (
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ClassDeclaration' ||
      parent.type === 'ClassExpression') &&
    parent.id === node
  ) {
    return true;
  }

  if (
    (parent.type === 'ImportSpecifier' ||
      parent.type === 'ImportDefaultSpecifier' ||
      parent.type === 'ImportNamespaceSpecifier') &&
    'local' in parent &&
    parent.local === node
  ) {
    return true;
  }

  return false;
};

const visit = (
  node: Node,
  scope: Scope | null,
  enter: (
    node: Node,
    scope: Scope,
    parent: Node | null,
    ancestors: Node[]
  ) => void,
  parent: Node | null = null,
  ancestors: Node[] = []
): void => {
  const visitNode = (
    currentNode: Node,
    currentScope: Scope | null,
    currentParent: Node | null
  ): void => {
    let nextScope: Scope;
    if (currentNode.type === 'Program') {
      nextScope = createScope(null, currentNode, true, true);
    } else if (
      currentNode.type === 'BlockStatement' ||
      currentNode.type === 'FunctionDeclaration' ||
      currentNode.type === 'FunctionExpression' ||
      currentNode.type === 'ArrowFunctionExpression'
    ) {
      nextScope = createScope(
        currentScope,
        currentNode,
        false,
        currentNode.type !== 'BlockStatement'
      );
    } else if (currentScope) {
      nextScope = currentScope;
    } else {
      nextScope = createScope(null, currentNode, false, true);
    }

    if (
      currentNode.type === 'FunctionDeclaration' ||
      currentNode.type === 'FunctionExpression' ||
      currentNode.type === 'ArrowFunctionExpression'
    ) {
      currentNode.params.forEach((param) => {
        collectBindingNames(param).forEach((name) => {
          nextScope.params.add(name);
          nextScope.bindings.set(name, {
            declaredAt: param.start,
            declaration: null,
            declarator: null,
            functionNode: null,
            isRoot: false,
            kind: 'param',
            name,
            scope: nextScope,
          });
        });
      });
    }

    enter(currentNode, nextScope, currentParent, ancestors);

    ancestors.push(currentNode);
    getChildren(currentNode).forEach((child) =>
      visitNode(child, nextScope, currentNode)
    );
    ancestors.pop();
  };

  visitNode(node, scope, parent);
};

const analyzeProgram = (
  program: Program,
  {
    collectTargetExpressions = false,
    collectTemplateLiterals = false,
    expressionSpanLookup = null,
    templateSpanLookup = null,
  }: {
    collectTargetExpressions?: boolean;
    collectTemplateLiterals?: boolean;
    expressionSpanLookup?: SpanLookup;
    templateSpanLookup?: SpanLookup;
  } = {}
): ProgramAnalysis => {
  const bindings = new Map<string, Binding[]>();
  const usedNames = new Set<string>();
  const templateLiterals: TemplateLiteral[] = [];
  const targetExpressions: Expression[] = [];

  const addBinding = (scope: Scope, binding: Binding): void => {
    scope.bindings.set(binding.name, binding);
    const existing = bindings.get(binding.name) ?? [];
    existing.push(binding);
    bindings.set(binding.name, existing);
  };

  const collectTargets = (node: Node, ancestors: Node[]): void => {
    if (
      collectTemplateLiterals &&
      node.type === 'TemplateLiteral' &&
      node.expressions.length > 0 &&
      !ancestors.some((ancestor) => ancestor.type === 'TemplateLiteral') &&
      matchesSpanLookup(node, templateSpanLookup)
    ) {
      templateLiterals.push(node);
    }

    if (
      collectTargetExpressions &&
      expressionSpanLookup &&
      matchesSpanLookup(node, expressionSpanLookup)
    ) {
      targetExpressions.push(node as Expression);
    }
  };

  visit(program, null, (node, scope, _parent, ancestors) => {
    collectTargets(node, ancestors);

    if (node.type === 'Identifier') {
      usedNames.add(node.name);
    }

    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      node.params.forEach((param) => {
        collectBindingNames(param).forEach((name) => {
          const binding = scope.bindings.get(name);
          if (binding) {
            addBinding(scope, binding);
          }
        });
      });

      if (node.type !== 'FunctionDeclaration') {
        return;
      }
    }

    if (node.type === 'ImportDeclaration') {
      const source = node.source.value;
      node.specifiers.forEach((specifier) => {
        addBinding(scope, {
          declaredAt: specifier.start,
          declaration: null,
          declarator: null,
          functionNode: null,
          importedFrom: source,
          isRoot: scope.root,
          kind: 'import',
          name: specifier.local.name,
          scope,
        });
      });
      return;
    }

    if (node.type !== 'VariableDeclaration') {
      if (node.type === 'FunctionDeclaration' && node.id) {
        const declarationScope = scope.parent ?? scope;
        const binding: Binding = {
          declaredAt: node.start,
          declaration: null,
          declarator: null,
          functionNode: node,
          isRoot: declarationScope.root,
          kind: 'function',
          name: node.id.name,
          scope: declarationScope,
        };
        addBinding(declarationScope, binding);
      }

      return;
    }

    node.declarations.forEach((declarator) => {
      collectBindingNames(declarator.id).forEach((name) => {
        const declarationKind = normalizeDeclarationKind(node.kind);
        const declarationScope = getDeclarationScope(scope, declarationKind);
        const binding: Binding = {
          declarationKind,
          declaredAt: declarator.start,
          declaration: node,
          declarator,
          functionNode: null,
          isRoot: declarationScope.root,
          kind: 'variable',
          name,
          scope: declarationScope,
        };
        addBinding(declarationScope, binding);
      });
    });
  });

  return {
    bindingsByName: bindings,
    rootMutationsByBinding: collectRootMutations(program),
    targetExpressions: targetExpressions.sort((a, b) => a.start - b.start),
    templateLiterals,
    usedNames,
  };
};

const resolveBindingAt = (
  ctx: Pick<ExtractionContext, 'bindingResolutionCache' | 'bindingsByName'>,
  name: string,
  referenceStart: number
): Binding | undefined => {
  const cachedBindings = ctx.bindingResolutionCache.get(name);
  if (cachedBindings?.has(referenceStart)) {
    return cachedBindings.get(referenceStart) ?? undefined;
  }

  const bindings = ctx.bindingsByName.get(name);
  const bindingCache = cachedBindings ?? new Map<number, Binding | null>();
  if (!cachedBindings) {
    ctx.bindingResolutionCache.set(name, bindingCache);
  }

  if (!bindings || bindings.length === 0) {
    bindingCache.set(referenceStart, null);
    return undefined;
  }

  let binding: Binding | undefined;
  bindings.forEach((candidate) => {
    if (
      candidate.scope.start > referenceStart ||
      referenceStart >= candidate.scope.end
    ) {
      return;
    }

    if (
      !binding ||
      candidate.scope.depth > binding.scope.depth ||
      (candidate.scope.depth === binding.scope.depth &&
        candidate.declaredAt > binding.declaredAt)
    ) {
      binding = candidate;
    }
  });

  bindingCache.set(referenceStart, binding ?? null);
  return binding;
};

const collectRootMutations = (
  program: Program
): Map<string, Array<AssignmentExpression | UpdateExpression>> => {
  const mutations = new Map<string, Array<AssignmentExpression | UpdateExpression>>();

  const getRootMutationTarget = (
    node: Node
  ): { binding: string; path: Array<string | number> } | null => {
    if (node.type === 'Identifier') {
      return {
        binding: node.name,
        path: [],
      };
    }

    if (node.type !== 'MemberExpression') {
      return null;
    }

    const parent = getRootMutationTarget(node.object);
    if (!parent) {
      return null;
    }

    const key = node.computed
      ? node.property.type === 'Literal' &&
        (typeof node.property.value === 'string' ||
          typeof node.property.value === 'number')
        ? node.property.value
        : null
      : node.property.type === 'Identifier'
        ? node.property.name
        : null;
    if (key === null) {
      return null;
    }

    return {
      binding: parent.binding,
      path: [...parent.path, key],
    };
  };

  program.body.forEach((statement) => {
    if (statement.type !== 'ExpressionStatement') {
      return;
    }

    const expression = statement.expression;
    if (expression.type === 'AssignmentExpression') {
      const target = getRootMutationTarget(expression.left);
      if (!target || target.path.length === 0) {
        return;
      }

      const bucket = mutations.get(target.binding) ?? [];
      bucket.push(expression);
      mutations.set(target.binding, bucket);
      return;
    }

    if (expression.type === 'UpdateExpression') {
      const target = getRootMutationTarget(expression.argument);
      if (!target || target.path.length === 0) {
        return;
      }

      const bucket = mutations.get(target.binding) ?? [];
      bucket.push(expression);
      mutations.set(target.binding, bucket);
    }
  });

  return mutations;
};

const hasLocalBinding = (scope: Scope, name: string): boolean => {
  let current: Scope | null = scope;

  while (current) {
    if (current.bindings.has(name)) {
      return true;
    }

    current = current.parent;
  }

  return false;
};

const hasLocalBindingCached = (
  scope: Scope,
  name: string,
  cache: WeakMap<Scope, Map<string, boolean>>
): boolean => {
  const scopeCache = cache.get(scope);
  if (scopeCache?.has(name)) {
    return scopeCache.get(name)!;
  }

  const result = hasLocalBinding(scope, name);
  const nextScopeCache = scopeCache ?? new Map<string, boolean>();
  nextScopeCache.set(name, result);
  if (!scopeCache) {
    cache.set(scope, nextScopeCache);
  }

  return result;
};

const findReferences = (
  node: Node,
  referenceCache?: WeakMap<Node, ReferenceIdentifier[]>
): ReferenceIdentifier[] => {
  const cachedReferences = referenceCache?.get(node);
  if (cachedReferences) {
    return cachedReferences;
  }

  const refs = new Map<string, ReferenceIdentifier>();
  const localBindingCache = new WeakMap<Scope, Map<string, boolean>>();

  visit(node, null, (current, scope, parent, ancestors) => {
    if (
      current.type !== 'Identifier' ||
      isInTypeContext(ancestors) ||
      isBindingPosition(current, parent) ||
      isPropertyOnlyIdentifier(current, parent) ||
      isObjectPropertyKey(current, parent) ||
      hasLocalBindingCached(scope, current.name, localBindingCache)
    ) {
      return;
    }

    const key = `${current.start}:${current.end}:${current.name}`;
    refs.set(key, {
      end: current.end,
      name: current.name,
      start: current.start,
    });
  });

  const resolvedReferences = [...refs.values()];
  referenceCache?.set(node, resolvedReferences);
  return resolvedReferences;
};

const isBindingDeclaredWithin = (binding: Binding, container: Node): boolean =>
  container.start <= binding.declaredAt && binding.declaredAt < container.end;

const literalCode = (value: unknown): string | null => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }

  if (typeof value === 'object' && value !== null) {
    return `(${JSON.stringify(value)})`;
  }

  return null;
};

const cloneStaticValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneStaticValue(item));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneStaticValue(item)])
    );
  }

  return value;
};

const getObjectMember = (
  objectValue: unknown,
  property: string | number
): unknown | undefined => {
  if (
    objectValue === null ||
    objectValue === undefined ||
    (typeof objectValue !== 'object' &&
      typeof objectValue !== 'string' &&
      typeof objectValue !== 'number' &&
      typeof objectValue !== 'boolean')
  ) {
    return undefined;
  }

  return (objectValue as Record<string | number, unknown>)[property];
};

type EvalEnv = Map<string, unknown>;

const assignPatternValue = (
  pattern: Node,
  value: unknown,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[]
): boolean => {
  if (pattern.type === 'Identifier') {
    env.set(pattern.name, value);
    return true;
  }

  if (pattern.type === 'AssignmentPattern') {
    return assignPatternValue(
      pattern.left,
      value === undefined ? evaluateStatic(pattern.right, ctx, env, stack) : value,
      ctx,
      env,
      stack
    );
  }

  if (pattern.type === 'ObjectPattern') {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    return pattern.properties.every((property) => {
      if (property.type === 'RestElement') {
        return false;
      }

      const key = property.computed
        ? evaluateStatic(property.key as Expression, ctx, env, stack)
        : property.key.type === 'Identifier'
          ? property.key.name
          : property.key.type === 'Literal'
            ? property.key.value
            : undefined;
      if (key === undefined || key === null) {
        return false;
      }

      return assignPatternValue(
        property.value,
        getObjectMember(value, key as string | number),
        ctx,
        env,
        stack
      );
    });
  }

  if (pattern.type === 'ArrayPattern') {
    if (!Array.isArray(value)) {
      return false;
    }

    return pattern.elements.every((element, index) =>
      element
        ? assignPatternValue(element, value[index], ctx, env, stack)
        : true
    );
  }

  return false;
};

const applyRootMutation = (
  bindingName: string,
  baseValue: unknown,
  mutation: AssignmentExpression | UpdateExpression,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[]
): unknown | undefined => {
  const resolvePath = (
    node: Node
  ): { path: Array<string | number> } | null => {
    if (node.type === 'Identifier') {
      return node.name === bindingName ? { path: [] } : null;
    }

    if (node.type !== 'MemberExpression') {
      return null;
    }

    const parent = resolvePath(node.object);
    if (!parent) {
      return null;
    }

    const key = node.computed
      ? evaluateStatic(node.property as Expression, ctx, env, stack)
      : node.property.type === 'Identifier'
        ? node.property.name
        : undefined;
    if (
      key === undefined ||
      key === null ||
      (typeof key !== 'string' && typeof key !== 'number')
    ) {
      return null;
    }

    return {
      path: [...parent.path, key],
    };
  };

  const pathInfo = resolvePath(
    mutation.type === 'AssignmentExpression' ? mutation.left : mutation.argument
  );
  if (!pathInfo) {
    return undefined;
  }

  const cloned = cloneStaticValue(baseValue);
  if (pathInfo.path.length === 0) {
    if (mutation.type !== 'AssignmentExpression') {
      return undefined;
    }

    return evaluateStatic(mutation.right, ctx, env, stack);
  }

  let target = cloned as Record<string | number, unknown>;
  for (let idx = 0; idx < pathInfo.path.length - 1; idx += 1) {
    const key = pathInfo.path[idx];
    const next = target?.[key];
    if (typeof next !== 'object' || next === null) {
      return undefined;
    }

    target = next as Record<string | number, unknown>;
  }

  const lastKey = pathInfo.path[pathInfo.path.length - 1]!;
  if (mutation.type === 'AssignmentExpression') {
    const nextValue = evaluateStatic(mutation.right, ctx, env, stack);
    if (nextValue === undefined) {
      return undefined;
    }

    target[lastKey] = nextValue;
    return cloned;
  }

  const currentValue = target[lastKey];
  if (typeof currentValue !== 'number') {
    return undefined;
  }

  target[lastKey] =
    mutation.operator === '++' ? currentValue + 1 : currentValue - 1;
  return cloned;
};

const evaluateFunctionCall = (
  fn: OxcFunctionLikeNode,
  args: unknown[],
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[]
): unknown | undefined => {
  if (fn.async || !fn.body) {
    return undefined;
  }

  const localEnv = new Map(env);
  for (let idx = 0; idx < fn.params.length; idx += 1) {
    if (!assignPatternValue(fn.params[idx], args[idx], ctx, localEnv, stack)) {
      return undefined;
    }
  }

  if (fn.body.type !== 'BlockStatement') {
    return evaluateStatic(fn.body as Expression, ctx, localEnv, stack);
  }

  for (const statement of fn.body.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations) {
        const value = declarator.init
          ? evaluateStatic(declarator.init, ctx, localEnv, stack)
          : undefined;
        if (!assignPatternValue(declarator.id, value, ctx, localEnv, stack)) {
          return undefined;
        }
      }
      continue;
    }

    if (statement.type === 'ReturnStatement') {
      if (!statement.argument) {
        return undefined;
      }

      return evaluateStatic(statement.argument, ctx, localEnv, stack);
    }

    return undefined;
  }

  return undefined;
};

const getConstantReplacement = (
  binding: Binding | undefined,
  ctx: ExtractionContext
): string | null => {
  const init = binding?.declarator?.init;
  if (!init) {
    return null;
  }

  if (init.type === 'Literal') {
    return literalCode(init.value);
  }

  if (
    init.type === 'ObjectExpression' &&
    binding?.isRoot &&
    binding.declarator?.id.type === 'Identifier'
  ) {
    const evaluated = evaluateStatic(binding.declarator.id, ctx);
    return literalCode(evaluated);
  }

  return null;
};

const replaceIdentifierReferences = (
  expression: Expression,
  replacements: Map<string, string>,
  code: string
): string => {
  const localReplacements: Replacement[] = [];
  const ancestors: Node[] = [];

  const walk = (current: Node, parent: Node | null) => {
    if (
      current.type === 'Identifier' &&
      replacements.has(current.name) &&
      !isInTypeContext(ancestors) &&
      !isBindingPosition(current, parent) &&
      !isPropertyOnlyIdentifier(current, parent) &&
      !isObjectPropertyKey(current, parent)
    ) {
      localReplacements.push({
        start: current.start,
        end: current.end,
        value: replacements.get(current.name)!,
      });
    }

    ancestors.push(current);
    getChildren(current).forEach((child) => walk(child, current));
    ancestors.pop();
  };

  walk(expression, null);

  let result = code.slice(expression.start, expression.end);
  localReplacements
    .sort((a, b) => b.start - a.start)
    .forEach((replacement) => {
      const start = replacement.start - expression.start;
      const end = replacement.end - expression.start;
      result = result.slice(0, start) + replacement.value + result.slice(end);
    });

  return result;
};

const evaluateBinary = (
  expression: Expression,
  ctx: ExtractionContext
): unknown | undefined => {
  if (expression.type !== 'BinaryExpression') {
    return undefined;
  }

  const left = evaluateStatic(expression.left as Expression, ctx);
  const right = evaluateStatic(expression.right as Expression, ctx);
  if (left === undefined || right === undefined) {
    return undefined;
  }

  if (expression.operator === '+') {
    if (typeof left === 'number' && typeof right === 'number') {
      return left + right;
    }

    if (
      (typeof left === 'string' || typeof left === 'number') &&
      (typeof right === 'string' || typeof right === 'number')
    ) {
      return `${left}${right}`;
    }
  }

  if (
    expression.operator === '*' &&
    typeof left === 'number' &&
    typeof right === 'number'
  ) {
    return left * right;
  }

  return undefined;
};

const evaluateStatic = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv = new Map(),
  stack: string[] = []
): unknown | undefined => {
  if (expression.type === 'Literal') {
    return expression.value;
  }

  if (expression.type === 'TemplateLiteral') {
    let result = '';

    for (let idx = 0; idx < expression.quasis.length; idx += 1) {
      result += expression.quasis[idx]?.value.cooked ?? '';

      const nextExpression = expression.expressions[idx];
      if (!nextExpression) {
        continue;
      }

      const value = evaluateStatic(nextExpression, ctx, env, stack);
      if (
        value === undefined ||
        (typeof value !== 'string' && typeof value !== 'number')
      ) {
        return undefined;
      }

      result += String(value);
    }

    return result;
  }

  if (expression.type === 'Identifier') {
    if (env.has(expression.name)) {
      return env.get(expression.name);
    }

    const binding = resolveBindingAt(ctx, expression.name, expression.start);
    if (!binding || binding.importedFrom) {
      return undefined;
    }

    if (binding.kind === 'param') {
      return undefined;
    }

    if (stack.includes(binding.name)) {
      return undefined;
    }

    let value: unknown | undefined;
    const declarator = binding.declarator;
    const init = declarator?.init;
    if (init) {
      if (declarator.id.type !== 'Identifier') {
        return undefined;
      }

      value = evaluateStatic(
        init,
        ctx,
        env,
        [...stack, binding.name]
      );
    } else if (binding.functionNode) {
      value = binding.functionNode;
    }

    if (
      value !== undefined &&
      binding.isRoot &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const mutations = ctx.rootMutationsByBinding.get(binding.name) ?? [];
      let nextValue = cloneStaticValue(value);
      for (const mutation of mutations) {
        if (mutation.start >= ctx.currentExpressionStart) {
          break;
        }

        const applied = applyRootMutation(
          binding.name,
          nextValue,
          mutation,
          ctx,
          env,
          [...stack, binding.name]
        );
        if (applied === undefined) {
          return undefined;
        }

        nextValue = applied;
      }

      return nextValue;
    }

    return value;
  }

  if (expression.type === 'ObjectExpression') {
    const result: Record<string, unknown> = {};

    for (const property of expression.properties) {
      if (property.type === 'SpreadElement') {
        const spreadValue = evaluateStatic(property.argument, ctx, env, stack);
        if (typeof spreadValue !== 'object' || spreadValue === null) {
          return undefined;
        }

        Object.assign(result, spreadValue);
        continue;
      }

      const key = property.computed
        ? evaluateStatic(property.key as Expression, ctx, env, stack)
        : property.key.type === 'Identifier'
          ? property.key.name
          : property.key.type === 'Literal'
            ? property.key.value
            : undefined;
      if (
        key === undefined ||
        key === null ||
        (typeof key !== 'string' && typeof key !== 'number')
      ) {
        return undefined;
      }

      const value = evaluateStatic(property.value, ctx, env, stack);
      if (value === undefined) {
        return undefined;
      }

      result[key] = value;
    }

    return result;
  }

  if (expression.type === 'ArrayExpression') {
    const result: unknown[] = [];

    for (const element of expression.elements) {
      if (!element || element.type === 'SpreadElement') {
        return undefined;
      }

      const value = evaluateStatic(element, ctx, env, stack);
      if (value === undefined) {
        return undefined;
      }

      result.push(value);
    }

    return result;
  }

  if (expression.type === 'MemberExpression') {
    const objectValue = evaluateStatic(expression.object, ctx, env, stack);
    const key = expression.computed
      ? evaluateStatic(expression.property as Expression, ctx, env, stack)
      : expression.property.type === 'Identifier'
        ? expression.property.name
        : undefined;
    if (
      objectValue === undefined ||
      key === undefined ||
      key === null ||
      (typeof key !== 'string' && typeof key !== 'number')
    ) {
      return undefined;
    }

    return getObjectMember(objectValue, key);
  }

  if (expression.type === 'NewExpression') {
    if (expression.callee.type !== 'Identifier' || expression.arguments.length !== 1) {
      return undefined;
    }

    const [argument] = expression.arguments;
    if (!argument || argument.type === 'SpreadElement') {
      return undefined;
    }

    const value = evaluateStatic(argument, ctx, env, stack);
    if (value === undefined) {
      return undefined;
    }

    if (expression.callee.name === 'String') {
      return String(value);
    }

    if (expression.callee.name === 'Number') {
      return Number(value);
    }

    if (expression.callee.name === 'Boolean') {
      return Boolean(value);
    }

    return undefined;
  }

  if (expression.type === 'CallExpression') {
    if (expression.callee.type === 'Identifier') {
      const args = expression.arguments.map((arg) =>
        arg.type === 'SpreadElement'
          ? undefined
          : evaluateStatic(arg, ctx, env, stack)
      );
      if (args.some((value) => value === undefined)) {
        return undefined;
      }

      if (expression.callee.name === 'String' && args.length === 1) {
        return String(args[0]);
      }

      if (expression.callee.name === 'Number' && args.length === 1) {
        return Number(args[0]);
      }

      if (expression.callee.name === 'Boolean' && args.length === 1) {
        return Boolean(args[0]);
      }

      const binding = resolveBindingAt(
        ctx,
        expression.callee.name,
        expression.callee.start
      );
      const fn = binding?.functionNode ?? binding?.declarator?.init;
      if (
        fn &&
        (fn.type === 'ArrowFunctionExpression' ||
          fn.type === 'FunctionDeclaration' ||
          fn.type === 'FunctionExpression')
      ) {
        return evaluateFunctionCall(
          fn,
          args,
          ctx,
          env,
          [...stack, expression.callee.name]
        );
      }
    }

    if (expression.callee.type === 'MemberExpression') {
      const objectValue = evaluateStatic(expression.callee.object, ctx, env, stack);
      const key = expression.callee.computed
        ? evaluateStatic(expression.callee.property as Expression, ctx, env, stack)
        : expression.callee.property.type === 'Identifier'
          ? expression.callee.property.name
          : undefined;
      if (typeof objectValue === 'string') {
        if (key === 'toLowerCase' && expression.arguments.length === 0) {
          return objectValue.toLowerCase();
        }

        if (key === 'toUpperCase' && expression.arguments.length === 0) {
          return objectValue.toUpperCase();
        }
      }
    }
  }

  return evaluateBinary(expression, ctx);
};

const substituteConstants = (
  expression: Expression,
  ctx: ExtractionContext
): string => {
  const replacements = new Map<string, string>();
  findReferences(expression, ctx.referencesByNode).forEach(({ name, start }) => {
    const replacement = getConstantReplacement(
      resolveBindingAt(ctx, name, start),
      ctx
    );
    if (replacement) {
      replacements.set(name, replacement);
    }
  });

  return replaceIdentifierReferences(expression, replacements, ctx.code);
};

const allocateExpressionName = (ctx: ExtractionContext): string => {
  let base = '_exp';
  let idx = 1;
  while (ctx.usedNames.has(base)) {
    idx += 1;
    base = `_exp${idx}`;
  }

  ctx.usedNames.add(base);
  return base;
};

const addHoistedCode = (
  key: string,
  code: string,
  ctx: ExtractionContext
): void => {
  if (ctx.hoistedDeclarations.has(key)) {
    return;
  }

  ctx.hoistedDeclarations.set(key, code);
  const declarations =
    ctx.hoistedDeclarationsByInsertionPoint.get(ctx.currentInsertionPoint) ??
    [];
  declarations.push(code);
  ctx.hoistedDeclarationsByInsertionPoint.set(
    ctx.currentInsertionPoint,
    declarations
  );
};

const declarationCode = (
  declaration: VariableDeclaration,
  declarator: VariableDeclarator,
  ctx: ExtractionContext
): string => {
  const source = ctx.code.slice(declarator.start, declarator.end);
  return `let ${source};`;
};

const assertHoistable = (
  binding: Binding,
  ctx: ExtractionContext,
  stack: string[] = []
): void => {
  if (!binding.declarator?.init || binding.importedFrom || binding.isRoot) {
    return;
  }

  if (stack.includes(binding.name)) {
    return;
  }

  const refs = findReferences(binding.declarator.init, ctx.referencesByNode);
  refs.forEach(({ name, start }) => {
    const nextBinding = resolveBindingAt(ctx, name, start);
    if (!nextBinding) {
      return;
    }

    if (nextBinding.kind === 'param') {
      throw new Error(
        `This identifier cannot be used in the template, because it is a function parameter.`
      );
    }

    assertHoistable(nextBinding, ctx, [...stack, binding.name]);
  });
};

const addHoistedDeclaration = (
  binding: Binding,
  ctx: ExtractionContext,
  stack: string[] = []
): void => {
  if (
    !binding.declaration ||
    !binding.declarator ||
    binding.importedFrom ||
    binding.isRoot ||
    stack.includes(binding.name)
  ) {
    return;
  }

  const hoistSource = binding.declarator.init ?? binding.declarator;
  findReferences(hoistSource, ctx.referencesByNode).forEach(({ name, start }) => {
      const dependency = resolveBindingAt(ctx, name, start);
      if (dependency) {
        addHoistedDeclaration(dependency, ctx, [...stack, binding.name]);
      }
    });

  if (!ctx.hoistedDeclarations.has(binding.name)) {
    addHoistedCode(
      binding.name,
      declarationCode(binding.declaration, binding.declarator, ctx),
      ctx
    );
    ctx.removedDeclarations.add(binding.declaration);
  }
};

const literalExpressionValue = (
  expression: Expression,
  ctx: ExtractionContext
): Omit<ExpressionValue, 'buildCodeFrameError'> | null => {
  if (expression.type !== 'Literal') {
    return null;
  }

  if (
    expression.value !== null &&
    typeof expression.value !== 'string' &&
    typeof expression.value !== 'number' &&
    typeof expression.value !== 'boolean'
  ) {
    return null;
  }

  let type:
    | 'BooleanLiteral'
    | 'NullLiteral'
    | 'NumericLiteral'
    | 'StringLiteral';
  if (expression.value === null) {
    type = 'NullLiteral';
  } else if (typeof expression.value === 'string') {
    type = 'StringLiteral';
  } else if (typeof expression.value === 'number') {
    type = 'NumericLiteral';
  } else {
    type = 'BooleanLiteral';
  }

  const loc = getSourceLocation(expression.start, expression.end, ctx);
  const ex =
    expression.value === null
      ? { loc, type }
      : {
          loc,
          type,
          value: expression.value,
        };

  return {
    ex,
    kind: ValueType.CONST,
    source: ctx.code.slice(expression.start, expression.end),
    value: expression.value,
  } as unknown as Omit<ExpressionValue, 'buildCodeFrameError'>;
};

const extractExpression = (
  expression: Expression,
  ctx: ExtractionContext,
  evaluate: boolean
): ExtractedExpression => {
  const source = ctx.code.slice(expression.start, expression.end);
  const isFunction =
    expression.type === 'FunctionExpression' ||
    expression.type === 'ArrowFunctionExpression';

  if (evaluate) {
    const evaluated = evaluateStatic(expression, ctx);
    const literal = literalCode(evaluated);
    if (literal) {
      findReferences(expression, ctx.referencesByNode).forEach(({ name }) =>
        ctx.dependencyNames.add(name)
      );
      return {
        expressionCode: literal,
        importedFrom: [],
        kind: isFunction ? ValueType.FUNCTION : ValueType.LAZY,
      };
    }
  }

  const substituted = evaluate ? substituteConstants(expression, ctx) : source;
  const importedFrom: string[] = [];

  findReferences(expression, ctx.referencesByNode).forEach(({ name, start }) => {
    const binding = resolveBindingAt(ctx, name, start);
    if (!binding) {
      return;
    }

    if (isFunction && isBindingDeclaredWithin(binding, expression)) {
      return;
    }

    ctx.dependencyNames.add(name);

    if (binding.importedFrom) {
      importedFrom.push(binding.importedFrom);
      return;
    }

    const replacement = getConstantReplacement(binding, ctx);
    if (evaluate && replacement) {
      return;
    }

    assertHoistable(binding, ctx);
    addHoistedDeclaration(binding, ctx);
  });

  return {
    expressionCode: substituted,
    importedFrom,
    kind: isFunction ? ValueType.FUNCTION : ValueType.LAZY,
  };
};

const getInsertionPoint = (
  program: Program,
  expression: Expression
): number => {
  const owner =
    program.body.find(
      (statement) =>
        statement.start <= expression.start && statement.end >= expression.end
    ) ?? program.body[0];

  if (!owner) {
    return 0;
  }

  return owner.start;
};

const getInsertionPoints = (
  program: Program,
  expressions: Expression[]
): number[] => {
  if (expressions.length === 0) {
    return [];
  }

  if (program.body.length === 0) {
    return expressions.map(() => 0);
  }

  const insertionPoints: number[] = [];
  let ownerIndex = 0;

  expressions.forEach((expression) => {
    while (
      ownerIndex < program.body.length - 1 &&
      program.body[ownerIndex]!.end < expression.start
    ) {
      ownerIndex += 1;
    }

    let owner: Program['body'][number] | undefined = program.body[ownerIndex];
    if (
      !owner ||
      owner.start > expression.start ||
      owner.end < expression.end
    ) {
      owner = program.body.find(
        (statement) =>
          statement.start <= expression.start && statement.end >= expression.end
      );
    }

    insertionPoints.push(owner?.start ?? 0);
  });

  return insertionPoints;
};

const applyReplacements = (
  code: string,
  replacements: Replacement[]
): string => {
  let result = code;
  replacements
    .sort((a, b) => b.start - a.start)
    .forEach((replacement) => {
      result =
        result.slice(0, replacement.start) +
        replacement.value +
        result.slice(replacement.end);
    });

  return result;
};

const extractExpressions = (
  code: string,
  filename: string,
  evaluate: boolean,
  program: Program,
  analysis: Pick<
    ProgramAnalysis,
    'bindingsByName' | 'rootMutationsByBinding' | 'usedNames'
  >,
  expressions: Expression[]
): TemplateExtractionResult => {
  if (expressions.length === 0) {
    return { code, dependencyNames: [], expressionValues: [] };
  }

  const insertionPoints = getInsertionPoints(program, expressions);
  const ctx: ExtractionContext = {
    bindingResolutionCache: new Map(),
    bindingsByName: analysis.bindingsByName,
    code,
    currentInsertionPoint: insertionPoints[0] ?? 0,
    currentExpressionStart: expressions[0].start,
    dependencyNames: new Set(),
    expressionValues: [],
    filename,
    hoistedDeclarations: new Map(),
    hoistedDeclarationsByInsertionPoint: new Map(),
    loc: createLocationLookup(code),
    referencesByNode: new WeakMap(),
    replacements: [],
    rootMutationsByBinding: analysis.rootMutationsByBinding,
    removedDeclarations: new Set(),
    usedNames: new Set(analysis.usedNames),
  };

  expressions.forEach((expression, index) => {
    ctx.currentInsertionPoint = insertionPoints[index] ?? 0;
    ctx.currentExpressionStart = expression.start;

    const literal = literalExpressionValue(expression, ctx);
    if (literal) {
      ctx.expressionValues.push(literal);
      return;
    }

    const { expressionCode, importedFrom, kind } = extractExpression(
      expression,
      ctx,
      evaluate
    );
    const expName = allocateExpressionName(ctx);

    addHoistedCode(
      expName,
      `const ${expName} = () => ${expressionCode};`,
      ctx
    );
    ctx.replacements.push({
      start: expression.start,
      end: expression.end,
      value: `${expName}()`,
    });
    ctx.expressionValues.push({
      ex: {
        loc: getSourceLocation(expression.start, expression.end, ctx),
        name: expName,
        type: 'Identifier',
      },
      importedFrom,
      kind,
      source: ctx.code.slice(expression.start, expression.end),
    } as unknown as Omit<ExpressionValue, 'buildCodeFrameError'>);
  });

  ctx.removedDeclarations.forEach((declaration) => {
    ctx.replacements.push({
      start: declaration.start,
      end: declaration.end,
      value: '',
    });
  });

  ctx.hoistedDeclarationsByInsertionPoint.forEach((declarations, point) => {
    ctx.replacements.push({
      start: point,
      end: point,
      value: `${declarations.join('\n')}\n`,
    });
  });

  return {
    code: applyReplacements(code, ctx.replacements),
    dependencyNames: [...ctx.dependencyNames],
    expressionValues: ctx.expressionValues,
  };
};

export const collectOxcExpressionDependencies = (
  code: string,
  filename: string,
  evaluate = false,
  targetExpressionSpans?: ExpressionSpan[]
): TemplateExtractionResult => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTargetExpressions: true,
    expressionSpanLookup: createSpanLookup(targetExpressionSpans),
  });

  return extractExpressions(
    code,
    filename,
    evaluate,
    program,
    analysis,
    analysis.targetExpressions
  );
};

export const collectOxcTemplateDependencies = (
  code: string,
  filename: string,
  evaluate = false,
  targetTemplateSpans?: ExpressionSpan[]
): TemplateExtractionResult => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTemplateLiterals: true,
    templateSpanLookup: createSpanLookup(targetTemplateSpans),
  });
  const expressions = analysis.templateLiterals.flatMap(
    (template) => template.expressions
  );

  return extractExpressions(code, filename, evaluate, program, analysis, expressions);
};
