/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { ExpressionValue, Location } from '@wyw-in-js/shared';
import { ValueType } from '@wyw-in-js/shared';
import type {
  AssignmentExpression,
  Expression,
  ImportDeclaration,
  ImportSpecifier,
  MemberExpression,
  ModuleExportName,
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
  imported?: 'default' | '*' | string;
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

export type OxcStaticImportReference = {
  imported: 'default' | string;
  importLocal?: string;
  local: string;
  source: string;
};

export type OxcStaticValue = {
  name: string;
  value: unknown;
};

export type OxcStaticValueCandidate = {
  imports: OxcStaticImportReference[];
  inlineConstants?: Record<string, unknown>;
  name: string;
  source: string;
};

type TemplateExtractionResult = {
  code: string;
  dependencyNames: string[];
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[];
  staticValueCandidates: OxcStaticValueCandidate[];
  staticValues: OxcStaticValue[];
};

export type StaticBindings = Record<string, Record<string, unknown>>;

type ExtractionContext = {
  bindingResolutionCache: Map<string, Map<number, Binding | null>>;
  bindingsByName: Map<string, Binding[]>;
  code: string;
  currentInsertionPoint: number;
  currentExpressionStart: number;
  dependencyNames: Set<string>;
  expressionValues: Omit<ExpressionValue, 'buildCodeFrameError'>[];
  filename: string;
  hoistedBindingNames: Map<string, string>;
  hoistedDeclarations: Map<string, string>;
  hoistedDeclarationsByInsertionPoint: Map<number, string[]>;
  loc: LocationLookup;
  referencesByNode: WeakMap<Node, ReferenceIdentifier[]>;
  replacements: Replacement[];
  rootMutationsByBinding: Map<
    string,
    Array<AssignmentExpression | UpdateExpression>
  >;
  staticBindings?: StaticBindings;
  staticImportAliases: Map<string, string>;
  staticValueCandidates: OxcStaticValueCandidate[];
  staticValues: OxcStaticValue[];
  usedNames: Set<string>;
};

export const lookupStaticBinding = (
  staticBindings: StaticBindings | undefined,
  source: string | undefined,
  imported: string | undefined
): { found: true; value: unknown } | { found: false } => {
  if (!staticBindings || !source || !imported) {
    return { found: false };
  }
  const sourceMap = staticBindings[source];
  if (!sourceMap) {
    return { found: false };
  }
  if (!Object.prototype.hasOwnProperty.call(sourceMap, imported)) {
    return { found: false };
  }
  return { found: true, value: sourceMap[imported] };
};

type ExtractedExpression = {
  expressionCode: string;
  hasInlinableLocalReference?: boolean;
  importedFrom: string[];
  kind: ValueType.FUNCTION | ValueType.LAZY;
  staticExpressionCode?: string;
  staticImports: OxcStaticImportReference[];
  staticValue?: unknown;
};

type StaticLocalExpression = {
  importedFrom: string[];
  imports: OxcStaticImportReference[];
  source: string;
};

type ProgramAnalysis = {
  bindingsByName: Map<string, Binding[]>;
  rootMutationsByBinding: Map<
    string,
    Array<AssignmentExpression | UpdateExpression>
  >;
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

const moduleExportName = (node: ModuleExportName): string =>
  node.type === 'Literal' ? String(node.value) : node.name;

const getImportSpecifierInfo = (
  statement: ImportDeclaration,
  specifier: ImportDeclaration['specifiers'][number]
): { imported: 'default' | '*' | string; local: string } | null => {
  const local = specifier.local?.name;
  if (!local) {
    return null;
  }

  if (specifier.type === 'ImportDefaultSpecifier') {
    return {
      imported: 'default',
      local,
    };
  }

  if (specifier.type === 'ImportNamespaceSpecifier') {
    return {
      imported: '*',
      local,
    };
  }

  if (
    statement.importKind === 'type' ||
    (specifier as ImportSpecifier).importKind === 'type'
  ) {
    return null;
  }

  return {
    imported: moduleExportName((specifier as ImportSpecifier).imported),
    local,
  };
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

    if (isInTypeContext(ancestors)) {
      return;
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
        const importInfo = getImportSpecifierInfo(node, specifier);
        if (!importInfo) {
          return;
        }

        addBinding(scope, {
          declaredAt: specifier.start,
          declaration: null,
          declarator: null,
          functionNode: null,
          imported: importInfo.imported,
          importedFrom: source,
          isRoot: scope.root,
          kind: 'import',
          name: importInfo.local,
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
  const mutations = new Map<
    string,
    Array<AssignmentExpression | UpdateExpression>
  >();

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

    let key: string | number | null = null;
    if (
      node.computed &&
      node.property.type === 'Literal' &&
      (typeof node.property.value === 'string' ||
        typeof node.property.value === 'number')
    ) {
      key = node.property.value;
    } else if (!node.computed && node.property.type === 'Identifier') {
      key = node.property.name;
    }
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

    const { expression } = statement;
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
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : null;
  }

  if (
    value === null ||
    typeof value === 'string' ||
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

const isStaticSerializableValue = (value: unknown): boolean =>
  literalCode(value) !== null;

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

const INT32_SIZE = 2 ** 32;
const INT32_SIGN_BIT = 2 ** 31;

const toInt32 = (value: number): number => {
  if (!Number.isFinite(value) || value === 0) {
    return 0;
  }

  const integer = Math.sign(value) * Math.floor(Math.abs(value));
  const int32bit = ((integer % INT32_SIZE) + INT32_SIZE) % INT32_SIZE;

  return int32bit >= INT32_SIGN_BIT ? int32bit - INT32_SIZE : int32bit;
};

const bitwiseNot = (value: number): number => -toInt32(value) - 1;

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

const oxcStaticCallableValue = Symbol('wyw.oxc.staticCallableValue');

type OxcStaticCallableValue = {
  [oxcStaticCallableValue]: unknown;
};

const isOxcStaticCallableValue = (
  value: unknown
): value is OxcStaticCallableValue =>
  typeof value === 'object' &&
  value !== null &&
  oxcStaticCallableValue in value;

const unwrapOxcStaticCallableValue = (value: unknown): unknown =>
  isOxcStaticCallableValue(value) ? value[oxcStaticCallableValue] : value;

export const createOxcStaticCallableValue = (
  value: unknown
): OxcStaticCallableValue => ({
  [oxcStaticCallableValue]: value,
});

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
      value === undefined
        ? evaluateStatic(pattern.right, ctx, env, stack)
        : value,
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

      let key: unknown;
      if (property.computed) {
        key = evaluateStatic(property.key as Expression, ctx, env, stack);
      } else if (property.key.type === 'Identifier') {
        key = property.key.name;
      } else if (property.key.type === 'Literal') {
        key = property.key.value;
      }
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
  const resolvePath = (node: Node): { path: Array<string | number> } | null => {
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

    let key: unknown;
    if (node.computed) {
      key = evaluateStatic(node.property as Expression, ctx, env, stack);
    } else if (node.property.type === 'Identifier') {
      key = node.property.name;
    }
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

const collectIdentifierReferenceReplacements = (
  expression: Expression,
  replacements: Map<string, string>
): Replacement[] => {
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
      const replacement = replacements.get(current.name)!;
      // Shorthand property `{ width }` → `{ width: 500 }` when the
      // identifier is the value side of a shorthand ObjectProperty.
      const isShorthandValue =
        !!parent &&
        parent.type === 'Property' &&
        (parent as unknown as { shorthand?: boolean }).shorthand &&
        parent.value === current;
      localReplacements.push({
        start: isShorthandValue ? parent.start : current.start,
        end: current.end,
        value: isShorthandValue
          ? `${current.name}: ${replacement}`
          : replacement,
      });
    }

    ancestors.push(current);
    getChildren(current).forEach((child) => walk(child, current));
    ancestors.pop();
  };

  walk(expression, null);
  return localReplacements;
};

const applyExpressionReplacements = (
  expression: Expression,
  replacements: Replacement[],
  code: string
): string => {
  let result = code.slice(expression.start, expression.end);
  replacements
    .sort((a, b) => b.start - a.start)
    .forEach((replacement) => {
      const start = replacement.start - expression.start;
      const end = replacement.end - expression.start;
      result = result.slice(0, start) + replacement.value + result.slice(end);
    });
  return result;
};

const replaceIdentifierReferences = (
  expression: Expression,
  replacements: Map<string, string>,
  code: string
): string => {
  return applyExpressionReplacements(
    expression,
    collectIdentifierReferenceReplacements(expression, replacements),
    code
  );
};

const staticImportAliasPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9_$]/g, '_') || 'value';

const allocateStaticImportAlias = (
  binding: Binding,
  imported: string,
  ctx: ExtractionContext
): string => {
  const key = `${binding.importedFrom ?? ''}\0${binding.name}\0${imported}`;
  const existing = ctx.staticImportAliases.get(key);
  if (existing) {
    return existing;
  }

  const namespacePart = staticImportAliasPart(binding.name);
  const importedPart = staticImportAliasPart(imported);
  let alias = `_wyw_static_${namespacePart}_${importedPart}`;
  let idx = 1;
  while (ctx.usedNames.has(alias)) {
    idx += 1;
    alias = `_wyw_static_${namespacePart}_${importedPart}_${idx}`;
  }

  ctx.usedNames.add(alias);
  ctx.staticImportAliases.set(key, alias);
  return alias;
};

const staticMemberPropertyName = (
  expression: MemberExpression
): string | null => {
  if (!expression.computed && expression.property.type === 'Identifier') {
    return expression.property.name;
  }

  if (
    expression.computed &&
    expression.property.type === 'Literal' &&
    typeof expression.property.value === 'string'
  ) {
    return expression.property.value;
  }

  return null;
};

const collectStaticNamespaceMemberReferences = (
  expression: Expression,
  ctx: ExtractionContext
): {
  coveredReferenceStarts: Set<number>;
  imports: OxcStaticImportReference[];
  replacements: Replacement[];
} => {
  const coveredReferenceStarts = new Set<number>();
  const imports = new Map<string, OxcStaticImportReference>();
  const replacements: Replacement[] = [];

  const walk = (node: Node): void => {
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier') {
      const binding = resolveBindingAt(
        ctx,
        node.object.name,
        node.object.start
      );
      const imported = staticMemberPropertyName(node);
      if (
        binding?.importedFrom &&
        binding.imported === '*' &&
        imported !== null
      ) {
        const alias = allocateStaticImportAlias(binding, imported, ctx);
        imports.set(`${binding.importedFrom}\0${imported}\0${alias}`, {
          imported,
          importLocal: binding.name,
          local: alias,
          source: binding.importedFrom,
        });
        replacements.push({
          end: node.end,
          start: node.start,
          value: alias,
        });
        coveredReferenceStarts.add(node.object.start);
      }
    }

    getChildren(node).forEach(walk);
  };

  walk(expression);

  return {
    coveredReferenceStarts,
    imports: [...imports.values()],
    replacements,
  };
};

const isProcessEnvMember = (node: Node): boolean => {
  if (node.type !== 'MemberExpression' || node.computed) {
    return false;
  }

  if (node.property.type !== 'Identifier' || node.property.name !== 'env') {
    return false;
  }

  return node.object.type === 'Identifier' && node.object.name === 'process';
};

const isProcessEnvValueAccess = (
  expression: Expression,
  env: EvalEnv
): boolean =>
  expression.type === 'MemberExpression' &&
  isProcessEnvMember(expression.object) &&
  !env.has('process');

const isDeterministicUndefinedExpression = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv
): boolean => {
  if (isProcessEnvValueAccess(expression, env)) {
    return true;
  }

  if (expression.type === 'UnaryExpression' && expression.operator === 'void') {
    return true;
  }

  return (
    expression.type === 'Identifier' &&
    expression.name === 'undefined' &&
    !resolveBindingAt(ctx, expression.name, expression.start)
  );
};

const evaluateBinary = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv = new Map(),
  stack: string[] = []
): unknown | undefined => {
  if (expression.type !== 'BinaryExpression') {
    return undefined;
  }

  const left = evaluateStatic(expression.left as Expression, ctx, env, stack);
  const right = evaluateStatic(expression.right as Expression, ctx, env, stack);

  const leftIsDeterministicUndefined =
    left === undefined &&
    isDeterministicUndefinedExpression(expression.left as Expression, ctx, env);
  const rightIsDeterministicUndefined =
    right === undefined &&
    isDeterministicUndefinedExpression(
      expression.right as Expression,
      ctx,
      env
    );

  if (
    (left === undefined && !leftIsDeterministicUndefined) ||
    (right === undefined && !rightIsDeterministicUndefined)
  ) {
    return undefined;
  }

  switch (expression.operator) {
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '==':
      // eslint-disable-next-line eqeqeq
      return left == right;
    case '!=':
      // eslint-disable-next-line eqeqeq
      return left != right;
    default:
      break;
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

  if (typeof left === 'number' && typeof right === 'number') {
    switch (expression.operator) {
      case '<':
        return left < right;
      case '<=':
        return left <= right;
      case '>':
        return left > right;
      case '>=':
        return left >= right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        return left / right;
      case '%':
        return left % right;
      case '**':
        return left ** right;
      default:
        break;
    }
  }

  return undefined;
};

const evaluateStatic = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv = new Map(),
  stack: string[] = []
): unknown | undefined => {
  if (
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSNonNullExpression' ||
    expression.type === 'TSInstantiationExpression' ||
    expression.type === 'TSTypeAssertion' ||
    expression.type === 'ParenthesizedExpression'
  ) {
    return evaluateStatic(expression.expression as Expression, ctx, env, stack);
  }

  if (expression.type === 'Literal') {
    return expression.value;
  }

  if (expression.type === 'UnaryExpression') {
    if (expression.operator === 'typeof') {
      const argIsProcessEnvAccess = isProcessEnvValueAccess(
        expression.argument as Expression,
        env
      );
      // `typeof someIdentifier` is the canonical undeclared-global
      // probe — it returns 'undefined' regardless of whether the
      // symbol is declared. Only fold truly unbound identifiers: declared
      // but dynamic locals still have runtime values we cannot infer.
      const argIsUnboundBareIdentifier =
        expression.argument.type === 'Identifier' &&
        !resolveBindingAt(
          ctx,
          expression.argument.name,
          expression.argument.start
        );
      const arg = evaluateStatic(
        expression.argument as Expression,
        ctx,
        env,
        stack
      );
      if (arg === undefined) {
        return argIsProcessEnvAccess || argIsUnboundBareIdentifier
          ? 'undefined'
          : undefined;
      }

      return typeof arg;
    }

    const arg = evaluateStatic(
      expression.argument as Expression,
      ctx,
      env,
      stack
    );
    if (arg === undefined) {
      return undefined;
    }

    switch (expression.operator) {
      case '-':
        return typeof arg === 'number' ? -arg : undefined;
      case '+':
        return typeof arg === 'number' ? +arg : undefined;
      case '!':
        return !arg;
      case '~':
        return typeof arg === 'number' ? bitwiseNot(arg) : undefined;
      case 'void':
        return undefined;
      default:
        return undefined;
    }
  }

  if (expression.type === 'LogicalExpression') {
    const left = evaluateStatic(expression.left, ctx, env, stack);
    // process.env.X access is the only source we trust as "deterministically
    // undefined" — it's a build-time lookup we control. For everything else,
    // undefined means "couldn't evaluate" and we must bail to avoid inlining
    // a wrong fallback when the runtime value isn't actually nullish.
    const leftIsProcessEnvAccess = isProcessEnvValueAccess(
      expression.left,
      env
    );

    if (left === undefined && !leftIsProcessEnvAccess) {
      return undefined;
    }

    if (expression.operator === '||') {
      return left || evaluateStatic(expression.right, ctx, env, stack);
    }

    if (expression.operator === '??') {
      return left ?? evaluateStatic(expression.right, ctx, env, stack);
    }

    if (expression.operator === '&&') {
      return left && evaluateStatic(expression.right, ctx, env, stack);
    }

    return undefined;
  }

  if (expression.type === 'ConditionalExpression') {
    const test = evaluateStatic(expression.test, ctx, env, stack);
    if (test === undefined) {
      return undefined;
    }

    return evaluateStatic(
      test ? expression.consequent : expression.alternate,
      ctx,
      env,
      stack
    );
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
      return unwrapOxcStaticCallableValue(env.get(expression.name));
    }

    const binding = resolveBindingAt(ctx, expression.name, expression.start);
    if (binding?.importedFrom) {
      // staticBindings can supply a literal value for an imported name,
      // bypassing whatever the source module would otherwise resolve to.
      // Function values are deferred to the CallExpression branch.
      const override = lookupStaticBinding(
        ctx.staticBindings,
        binding.importedFrom,
        binding.imported
      );
      if (override.found && typeof override.value !== 'function') {
        return override.value;
      }
      return undefined;
    }
    if (!binding) {
      return undefined;
    }

    if (binding.kind === 'param') {
      return undefined;
    }

    if (stack.includes(binding.name)) {
      return undefined;
    }

    let value: unknown | undefined;
    const { declarator } = binding;
    const init = declarator?.init;
    if (init) {
      if (declarator.id.type !== 'Identifier') {
        return undefined;
      }

      value = evaluateStatic(init, ctx, env, [...stack, binding.name]);
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

      let key: unknown;
      if (property.computed) {
        key = evaluateStatic(property.key as Expression, ctx, env, stack);
      } else if (property.key.type === 'Identifier') {
        key = property.key.name;
      } else if (property.key.type === 'Literal') {
        key = property.key.value;
      }
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
      if (!element) {
        return undefined;
      }

      if (element.type === 'SpreadElement') {
        const spreadValue = evaluateStatic(element.argument, ctx, env, stack);
        if (!Array.isArray(spreadValue)) {
          return undefined;
        }

        result.push(...spreadValue);
        continue;
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
    let key: unknown;
    if (expression.computed) {
      key = evaluateStatic(expression.property as Expression, ctx, env, stack);
    } else if (expression.property.type === 'Identifier') {
      key = expression.property.name;
    }
    if (
      key === undefined ||
      key === null ||
      (typeof key !== 'string' && typeof key !== 'number')
    ) {
      return undefined;
    }

    if (isProcessEnvValueAccess(expression, env) && typeof key === 'string') {
      // Treat process.env.X as deterministically undefined at build time.
      // Reading from real process.env would couple the bundle to whatever
      // happens to be set on the build machine; falling back to the
      // ?? / || branch (or a runtime read) is more predictable.
      return undefined;
    }

    const objectValue = evaluateStatic(expression.object, ctx, env, stack);
    if (objectValue === undefined) {
      return undefined;
    }

    return getObjectMember(objectValue, key);
  }

  if (expression.type === 'NewExpression') {
    if (
      expression.callee.type !== 'Identifier' ||
      expression.arguments.length !== 1
    ) {
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

      const staticCallable = env.get(expression.callee.name);
      if (
        isOxcStaticCallableValue(staticCallable) &&
        expression.arguments.length === 0
      ) {
        return unwrapOxcStaticCallableValue(staticCallable);
      }

      // Plain function in env (e.g. supplied via staticBindings as a
      // pure helper). Invoke with already-evaluated args.
      if (typeof staticCallable === 'function') {
        try {
          return (staticCallable as (...a: unknown[]) => unknown)(...args);
        } catch {
          return undefined;
        }
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

      // staticBindings can register a pure helper for an imported name
      // (e.g. linaria's `cx` from '@linaria/core'). When the callee
      // resolves to such an import and every arg evaluated, invoke the
      // helper and return its result as a static value.
      if (binding?.importedFrom) {
        const override = lookupStaticBinding(
          ctx.staticBindings,
          binding.importedFrom,
          binding.imported
        );
        if (override.found && typeof override.value === 'function') {
          try {
            return (override.value as (...a: unknown[]) => unknown)(...args);
          } catch {
            return undefined;
          }
        }
      }

      const fn = binding?.functionNode ?? binding?.declarator?.init;
      if (
        fn &&
        (fn.type === 'ArrowFunctionExpression' ||
          fn.type === 'FunctionDeclaration' ||
          fn.type === 'FunctionExpression')
      ) {
        return evaluateFunctionCall(fn, args, ctx, env, [
          ...stack,
          expression.callee.name,
        ]);
      }
    }

    if (expression.callee.type === 'MemberExpression') {
      const objectValue = evaluateStatic(
        expression.callee.object,
        ctx,
        env,
        stack
      );
      let key: unknown;
      if (expression.callee.computed) {
        key = evaluateStatic(
          expression.callee.property as Expression,
          ctx,
          env,
          stack
        );
      } else if (expression.callee.property.type === 'Identifier') {
        key = expression.callee.property.name;
      }
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

  return evaluateBinary(expression, ctx, env, stack);
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

const hoistedBindingKey = (binding: Binding): string =>
  `${binding.scope.start}:${binding.scope.end}:${binding.declaredAt}:${binding.name}`;

const allocateHoistedBindingName = (
  originalName: string,
  ctx: ExtractionContext
): string => {
  const sanitized = originalName.replace(/[^A-Za-z0-9_$]/g, '_') || 'hoisted';
  const base = /^[A-Za-z_$]/.test(sanitized) ? `_${sanitized}` : '_hoisted';
  let candidate = base;
  let idx = 2;

  while (ctx.usedNames.has(candidate)) {
    candidate = `${base}${idx}`;
    idx += 1;
  }

  ctx.usedNames.add(candidate);
  return candidate;
};

const getHoistedBindingName = (
  binding: Binding,
  ctx: ExtractionContext
): string => {
  const key = hoistedBindingKey(binding);
  const existing = ctx.hoistedBindingNames.get(key);
  if (existing) {
    return existing;
  }

  const next = allocateHoistedBindingName(binding.name, ctx);
  ctx.hoistedBindingNames.set(key, next);
  return next;
};

const parenthesizeStaticReplacement = (source: string): string => `(${source})`;

const replaceStaticLocalReferences = (
  expression: Expression,
  replacements: Map<string, string>,
  ctx: ExtractionContext,
  extraReplacements: Replacement[] = []
): string => {
  if (expression.type === 'Identifier' && extraReplacements.length === 0) {
    return (
      replacements.get(expression.name) ??
      ctx.code.slice(expression.start, expression.end)
    );
  }

  const parenthesized = new Map<string, string>();
  replacements.forEach((value, key) => {
    parenthesized.set(key, parenthesizeStaticReplacement(value));
  });

  return applyExpressionReplacements(
    expression,
    [
      ...extraReplacements,
      ...collectIdentifierReferenceReplacements(expression, parenthesized),
    ],
    ctx.code
  );
};

const collectStaticLocalExpression = (
  expression: Expression,
  ctx: ExtractionContext,
  stack: string[] = []
): StaticLocalExpression | null => {
  const replacements = new Map<string, string>();
  const importedFrom = new Set<string>();
  const imports: OxcStaticImportReference[] = [];

  for (const { name, start } of findReferences(
    expression,
    ctx.referencesByNode
  )) {
    const binding = resolveBindingAt(ctx, name, start);
    if (!binding) {
      return null;
    }

    if (binding.importedFrom) {
      importedFrom.add(binding.importedFrom);
      if (binding.imported && binding.imported !== '*') {
        imports.push({
          imported: binding.imported,
          local: binding.name,
          source: binding.importedFrom,
        });
        continue;
      }

      return null;
    }

    const replacement = getConstantReplacement(binding, ctx);
    if (replacement) {
      replacements.set(name, replacement);
      continue;
    }

    if (
      binding.kind === 'param' ||
      binding.declarationKind !== 'const' ||
      !binding.declarator?.init ||
      binding.declarator.id.type !== 'Identifier'
    ) {
      return null;
    }

    // Processor-managed bindings (const x = css``) carry their value
    // (the generated className string) via inlineConstants at candidate
    // evaluation time. Walking the TaggedTemplateExpression here would
    // pull the processor's tag import (e.g. `css` from '@linaria/core')
    // into the candidate's static imports, where it fails to resolve.
    // Leave the identifier as a free reference; the candidate-side env
    // supplies the className.
    if (binding.declarator.init.type === 'TaggedTemplateExpression') {
      continue;
    }

    const key = hoistedBindingKey(binding);
    if (stack.includes(key)) {
      return null;
    }

    const nested = collectStaticLocalExpression(binding.declarator.init, ctx, [
      ...stack,
      key,
    ]);
    if (!nested) {
      return null;
    }

    replacements.set(name, nested.source);
    nested.importedFrom.forEach((source) => importedFrom.add(source));
    imports.push(...nested.imports);
  }

  return {
    importedFrom: [...importedFrom],
    imports,
    source:
      replacements.size > 0
        ? replaceStaticLocalReferences(expression, replacements, ctx)
        : ctx.code.slice(expression.start, expression.end),
  };
};

const declarationInitCode = (
  init: Expression,
  ctx: ExtractionContext
): string => {
  const renamedDependencies = new Map<string, string>();
  findReferences(init, ctx.referencesByNode).forEach(({ name, start }) => {
    const dependency = resolveBindingAt(ctx, name, start);
    if (
      !dependency ||
      dependency.importedFrom ||
      dependency.isRoot ||
      dependency.declarator?.id.type !== 'Identifier'
    ) {
      return;
    }

    renamedDependencies.set(name, getHoistedBindingName(dependency, ctx));
  });

  return renamedDependencies.size > 0
    ? replaceIdentifierReferences(init, renamedDependencies, ctx.code)
    : ctx.code.slice(init.start, init.end);
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

const declarationCode = (binding: Binding, ctx: ExtractionContext): string => {
  const { declarator } = binding;
  if (!declarator) {
    return '';
  }

  const { id } = declarator;
  if (id.type !== 'Identifier') {
    const idCode = ctx.code.slice(id.start, id.end);
    if (!declarator.init) {
      return `let ${idCode};`;
    }

    return `let ${idCode} = ${declarationInitCode(declarator.init, ctx)};`;
  }

  const hoistedName = getHoistedBindingName(binding, ctx);
  if (!declarator.init) {
    return `let ${hoistedName};`;
  }

  return `let ${hoistedName} = ${declarationInitCode(declarator.init, ctx)};`;
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
  findReferences(hoistSource, ctx.referencesByNode).forEach(
    ({ name, start }) => {
      const dependency = resolveBindingAt(ctx, name, start);
      if (dependency) {
        addHoistedDeclaration(dependency, ctx, [...stack, binding.name]);
      }
    }
  );

  if (!ctx.hoistedDeclarations.has(binding.name)) {
    addHoistedCode(binding.name, declarationCode(binding, ctx), ctx);
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
  // Only inline function expressions are function-valued here. A bare
  // identifier that points to a local function may be a styled runtime
  // component, so it has to stay as a lazy `_exp()` reference.
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
        staticImports: [],
        staticValue: isStaticSerializableValue(evaluated)
          ? cloneStaticValue(evaluated)
          : undefined,
      };
    }
  }

  const identifierReplacements = new Map<string, string>();
  const importedFrom: string[] = [];
  const namespaceStatic = collectStaticNamespaceMemberReferences(
    expression,
    ctx
  );
  const staticIdentifierReplacements = new Map<string, string>();
  const staticImports: OxcStaticImportReference[] = [
    ...namespaceStatic.imports,
  ];
  let hasNonStaticLocalReference = false;
  let hasInlinableLocalReference = false;

  findReferences(expression, ctx.referencesByNode).forEach(
    ({ name, start }) => {
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
        if (binding.imported && binding.imported !== '*') {
          staticImports.push({
            imported: binding.imported,
            local: binding.name,
            source: binding.importedFrom,
          });
        } else if (
          binding.imported === '*' &&
          namespaceStatic.coveredReferenceStarts.has(start)
        ) {
          // The static candidate source gets a synthetic named import alias,
          // while the eval fallback keeps the original namespace expression.
        } else {
          hasNonStaticLocalReference = true;
        }
        return;
      }

      const replacement = getConstantReplacement(binding, ctx);
      if (evaluate && replacement) {
        identifierReplacements.set(name, replacement);
        return;
      }

      const init = binding.declarator?.init;
      // Processor-managed bindings (const x = css``) carry a value (the
      // generated class name) that only becomes known after processors run.
      // Leave the identifier free in the candidate source so the resolver
      // can supply it via inlineConstants at evaluation time. Substituting
      // the TaggedTemplateExpression text would just guarantee evaluator
      // failure since evaluateStatic can't fold tagged templates.
      const isProcessorTagged =
        evaluate && init?.type === 'TaggedTemplateExpression';
      const staticLocalExpression =
        evaluate && init && !isProcessorTagged
          ? collectStaticLocalExpression(init, ctx, [
              hoistedBindingKey(binding),
            ])
          : null;
      if (staticLocalExpression) {
        staticIdentifierReplacements.set(name, staticLocalExpression.source);
        importedFrom.push(...staticLocalExpression.importedFrom);
        staticImports.push(...staticLocalExpression.imports);
      } else if (isProcessorTagged) {
        hasInlinableLocalReference = true;
      } else {
        hasNonStaticLocalReference = true;
      }

      assertHoistable(binding, ctx);
      addHoistedDeclaration(binding, ctx);
      if (!binding.isRoot && binding.declarator?.id.type === 'Identifier') {
        identifierReplacements.set(name, getHoistedBindingName(binding, ctx));
      }
    }
  );

  // Merge literal-const inlines (e.g. `const A = 32` -> "32") with
  // local-to-imported substitutions (e.g. `const X = imp.y` -> "imp.y").
  // Both must reach the candidate source so the resolver's evaluator
  // can fold every Identifier in the expression; env only carries
  // imported bindings, never same-file locals.
  const mergedReplacements = new Map(staticIdentifierReplacements);
  identifierReplacements.forEach((value, key) => {
    if (!mergedReplacements.has(key)) {
      mergedReplacements.set(key, value);
    }
  });

  let staticExpressionCode: string | undefined;
  if (mergedReplacements.size > 0) {
    staticExpressionCode = replaceStaticLocalReferences(
      expression,
      mergedReplacements,
      ctx,
      namespaceStatic.replacements
    );
  } else if (namespaceStatic.replacements.length > 0) {
    staticExpressionCode = applyExpressionReplacements(
      expression,
      namespaceStatic.replacements,
      ctx.code
    );
  }

  return {
    expressionCode:
      identifierReplacements.size > 0
        ? replaceIdentifierReferences(
            expression,
            identifierReplacements,
            ctx.code
          )
        : source,
    importedFrom,
    kind: isFunction ? ValueType.FUNCTION : ValueType.LAZY,
    staticExpressionCode,
    hasInlinableLocalReference:
      !hasNonStaticLocalReference && hasInlinableLocalReference,
    staticImports: hasNonStaticLocalReference ? [] : staticImports,
  };
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
  expressions: Expression[],
  staticBindings?: StaticBindings
): TemplateExtractionResult => {
  if (expressions.length === 0) {
    return {
      code,
      dependencyNames: [],
      expressionValues: [],
      staticValueCandidates: [],
      staticValues: [],
    };
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
    hoistedBindingNames: new Map(),
    hoistedDeclarations: new Map(),
    hoistedDeclarationsByInsertionPoint: new Map(),
    loc: createLocationLookup(code),
    referencesByNode: new WeakMap(),
    replacements: [],
    rootMutationsByBinding: analysis.rootMutationsByBinding,
    staticBindings,
    staticImportAliases: new Map(),
    staticValueCandidates: [],
    staticValues: [],
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

    const {
      expressionCode,
      hasInlinableLocalReference,
      importedFrom,
      kind,
      staticExpressionCode,
      staticImports,
      staticValue,
    } = extractExpression(expression, ctx, evaluate);
    const expName = allocateExpressionName(ctx);

    addHoistedCode(
      expName,
      `const ${expName} = () => (${expressionCode});`,
      ctx
    );
    if (staticValue !== undefined && kind !== ValueType.FUNCTION) {
      ctx.staticValues.push({
        name: expName,
        value: staticValue,
      });
    } else if (
      (staticImports.length > 0 ||
        hasInlinableLocalReference ||
        staticExpressionCode !== undefined) &&
      kind !== ValueType.FUNCTION
    ) {
      const uniqueImports = new Map<string, OxcStaticImportReference>();
      staticImports.forEach((item) => {
        uniqueImports.set(
          `${item.local}\0${item.importLocal ?? ''}\0${item.source}\0${
            item.imported
          }`,
          item
        );
      });
      ctx.staticValueCandidates.push({
        imports: [...uniqueImports.values()],
        name: expName,
        source: staticExpressionCode ?? expressionCode,
      });
    }
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
    staticValueCandidates: ctx.staticValueCandidates,
    staticValues: ctx.staticValues,
  };
};

export const isOxcStaticSerializableValue = (value: unknown): boolean =>
  isStaticSerializableValue(value);

export const evaluateOxcStaticExpressionAt = (
  code: string,
  filename: string,
  expressionSpan: ExpressionSpan,
  env: Map<string, unknown> = new Map(),
  staticBindings?: StaticBindings
): unknown | undefined => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTargetExpressions: true,
    expressionSpanLookup: createSpanLookup([expressionSpan]),
  });
  const [expression] = analysis.targetExpressions;
  if (!expression) {
    return undefined;
  }

  const ctx: ExtractionContext = {
    bindingResolutionCache: new Map(),
    bindingsByName: analysis.bindingsByName,
    code,
    currentInsertionPoint: 0,
    currentExpressionStart: expression.start,
    dependencyNames: new Set(),
    expressionValues: [],
    filename,
    hoistedBindingNames: new Map(),
    hoistedDeclarations: new Map(),
    hoistedDeclarationsByInsertionPoint: new Map(),
    loc: createLocationLookup(code),
    referencesByNode: new WeakMap(),
    replacements: [],
    rootMutationsByBinding: analysis.rootMutationsByBinding,
    staticBindings,
    staticImportAliases: new Map(),
    staticValueCandidates: [],
    staticValues: [],
    usedNames: new Set(analysis.usedNames),
  };

  return evaluateStatic(expression, ctx, new Map(env));
};

export const evaluateOxcStaticExpression = (
  source: string,
  filename: string,
  env: Map<string, unknown> = new Map(),
  staticBindings?: StaticBindings
): unknown | undefined => {
  const code = `const __wyw_static_value = ${source};`;
  const program = parseOxc(code, filename);
  const declaration = program.body[0];
  if (declaration?.type !== 'VariableDeclaration') {
    return undefined;
  }

  const [declarator] = declaration.declarations;
  if (!declarator?.init) {
    return undefined;
  }

  return evaluateOxcStaticExpressionAt(
    code,
    filename,
    {
      end: declarator.init.end,
      start: declarator.init.start,
    },
    env,
    staticBindings
  );
};

export const collectOxcExpressionDependencies = (
  code: string,
  filename: string,
  evaluate = false,
  targetExpressionSpans?: ExpressionSpan[],
  staticBindings?: StaticBindings
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
    analysis.targetExpressions,
    staticBindings
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

  return extractExpressions(
    code,
    filename,
    evaluate,
    program,
    analysis,
    expressions
  );
};
