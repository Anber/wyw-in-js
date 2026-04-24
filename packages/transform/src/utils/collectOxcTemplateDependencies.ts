/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { parseSync } from 'oxc-parser';
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
  const parsed = parseSync(filename, code, {
    astType:
      filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js',
    range: true,
    sourceType: 'unambiguous',
  });
  const fatalError = parsed.errors.find((error) => error.severity === 'Error');
  if (fatalError) {
    throw new Error(fatalError.message);
  }

  return parsed.program as Program;
};

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
  let currentScope: Scope;
  if (node.type === 'Program') {
    currentScope = createScope(null, node, true, true);
  } else if (
    node.type === 'BlockStatement' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    currentScope = createScope(
      scope,
      node,
      false,
      node.type !== 'BlockStatement'
    );
  } else if (scope) {
    currentScope = scope;
  } else {
    currentScope = createScope(null, node, false, true);
  }

  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    node.params.forEach((param) => {
      collectBindingNames(param).forEach((name) => {
        currentScope.params.add(name);
        currentScope.bindings.set(name, {
          declaredAt: param.start,
          declaration: null,
          declarator: null,
          functionNode: null,
          isRoot: false,
          kind: 'param',
          name,
          scope: currentScope,
        });
      });
    });
  }

  enter(node, currentScope, parent, ancestors);

  getChildren(node).forEach((child) =>
    visit(child, currentScope, enter, node, [...ancestors, node])
  );
};

const collectBindings = (program: Program): Map<string, Binding[]> => {
  const bindings = new Map<string, Binding[]>();

  const addBinding = (scope: Scope, binding: Binding): void => {
    scope.bindings.set(binding.name, binding);
    const existing = bindings.get(binding.name) ?? [];
    existing.push(binding);
    bindings.set(binding.name, existing);
  };

  const normalizeDeclarationKind = (
    declarationKind: VariableDeclaration['kind']
  ): ScopedDeclarationKind => {
    // `using` declarations are block-scoped like `const` for binding lookup.
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

  visit(program, null, (node, scope) => {
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

  return bindings;
};

const resolveBindingAt = (
  ctx: Pick<ExtractionContext, 'bindingsByName'>,
  name: string,
  referenceStart: number
): Binding | undefined => {
  const bindings = ctx.bindingsByName.get(name);
  if (!bindings || bindings.length === 0) {
    return undefined;
  }

  return [...bindings]
    .filter(
      (binding) =>
        binding.scope.start <= referenceStart && referenceStart < binding.scope.end
    )
    .sort((left, right) => {
      if (left.scope.depth !== right.scope.depth) {
        return right.scope.depth - left.scope.depth;
      }

      return right.declaredAt - left.declaredAt;
    })[0];
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

const collectUsedNames = (program: Program): Set<string> => {
  const used = new Set<string>();
  visit(program, null, (node) => {
    if (node.type === 'Identifier') {
      used.add(node.name);
    }
  });

  return used;
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

const findReferences = (node: Node): ReferenceIdentifier[] => {
  const refs = new Map<string, ReferenceIdentifier>();

  visit(node, null, (current, scope, parent, ancestors) => {
    if (
      current.type !== 'Identifier' ||
      isInTypeContext(ancestors) ||
      isBindingPosition(current, parent) ||
      isPropertyOnlyIdentifier(current, parent) ||
      isObjectPropertyKey(current, parent) ||
      hasLocalBinding(scope, current.name)
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

  return [...refs.values()];
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

  const walk = (current: Node, parent: Node | null, ancestors: Node[]) => {
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

    getChildren(current).forEach((child) =>
      walk(child, current, [...ancestors, current])
    );
  };

  walk(expression, null, []);

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
    if (binding.declarator?.init) {
      if (binding.declarator.id.type !== 'Identifier') {
        return undefined;
      }

      value = evaluateStatic(
        binding.declarator.init,
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
  findReferences(expression).forEach(({ name, start }) => {
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

  const refs = findReferences(binding.declarator.init);
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

  findReferences(binding.declarator.init ?? binding.declarator).forEach(
    ({ name, start }) => {
      const dependency = resolveBindingAt(ctx, name, start);
      if (dependency) {
        addHoistedDeclaration(dependency, ctx, [...stack, binding.name]);
      }
    }
  );

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
      findReferences(expression).forEach(({ name }) => ctx.dependencyNames.add(name));
      return {
        expressionCode: literal,
        importedFrom: [],
        kind: isFunction ? ValueType.FUNCTION : ValueType.LAZY,
      };
    }
  }

  const substituted = evaluate ? substituteConstants(expression, ctx) : source;
  const importedFrom: string[] = [];

  findReferences(expression).forEach(({ name, start }) => {
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

const isTargetTemplate = (
  template: TemplateLiteral,
  targetTemplateSpans?: ExpressionSpan[]
): boolean =>
  !targetTemplateSpans ||
  targetTemplateSpans.some(
    (span) => span.start === template.start && span.end === template.end
  );

const collectTemplateLiterals = (
  program: Program,
  targetTemplateSpans?: ExpressionSpan[]
): TemplateLiteral[] => {
  const templates: TemplateLiteral[] = [];
  visit(program, null, (node, _scope, _parent, ancestors) => {
    if (
      node.type === 'TemplateLiteral' &&
      node.expressions.length > 0 &&
      !ancestors.some((ancestor) => ancestor.type === 'TemplateLiteral') &&
      isTargetTemplate(node, targetTemplateSpans)
    ) {
      templates.push(node);
    }
  });

  return templates;
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

const isTargetExpression = (
  expression: Expression,
  targetExpressionSpans?: ExpressionSpan[]
): boolean =>
  !targetExpressionSpans ||
  targetExpressionSpans.some(
    (span) => span.start === expression.start && span.end === expression.end
  );

const collectTargetExpressions = (
  program: Program,
  targetExpressionSpans?: ExpressionSpan[]
): Expression[] => {
  if (!targetExpressionSpans || targetExpressionSpans.length === 0) {
    return [];
  }

  const expressions: Expression[] = [];
  visit(program, null, (node) => {
    if (
      'start' in node &&
      'end' in node &&
      isTargetExpression(node as Expression, targetExpressionSpans)
    ) {
      expressions.push(node as Expression);
    }
  });

  return expressions.sort((a, b) => a.start - b.start);
};

const extractExpressions = (
  code: string,
  filename: string,
  evaluate: boolean,
  expressions: Expression[]
): TemplateExtractionResult => {
  const program = parseOxc(code, filename);
  if (expressions.length === 0) {
    return { code, dependencyNames: [], expressionValues: [] };
  }

  const ctx: ExtractionContext = {
    bindingsByName: collectBindings(program),
    code,
    currentInsertionPoint: getInsertionPoint(program, expressions[0]),
    currentExpressionStart: expressions[0].start,
    dependencyNames: new Set(),
    expressionValues: [],
    filename,
    hoistedDeclarations: new Map(),
    hoistedDeclarationsByInsertionPoint: new Map(),
    loc: createLocationLookup(code),
    replacements: [],
    rootMutationsByBinding: collectRootMutations(program),
    removedDeclarations: new Set(),
    usedNames: collectUsedNames(program),
  };

  expressions.forEach((expression) => {
    ctx.currentInsertionPoint = getInsertionPoint(program, expression);
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
  const expressions = collectTargetExpressions(program, targetExpressionSpans);
  return extractExpressions(code, filename, evaluate, expressions);
};

export const collectOxcTemplateDependencies = (
  code: string,
  filename: string,
  evaluate = false,
  targetTemplateSpans?: ExpressionSpan[]
): TemplateExtractionResult => {
  const program = parseOxc(code, filename);
  const templates = collectTemplateLiterals(program, targetTemplateSpans);
  const expressions = templates.flatMap((template) => template.expressions);
  return extractExpressions(code, filename, evaluate, expressions);
};
