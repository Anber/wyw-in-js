/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { SourceLocation } from '@wyw-in-js/shared';
import type {
  AssignmentExpression,
  Expression,
  ImportDeclaration,
  ImportSpecifier,
  ModuleExportName,
  Node,
  Program,
  TemplateLiteral,
  UpdateExpression,
  VariableDeclaration,
} from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { parseOxcProgram } from '../oxc/parse';
import { createOxcSourceLocation } from '../oxc/sourceLocations';
import type {
  Binding,
  ExpressionSpan,
  ExtractionContext,
  ProgramAnalysis,
  ReferenceIdentifier,
  Scope,
  ScopedDeclarationKind,
  SpanLookup,
} from './types';

export const containsTaggedTemplateExpression = (node: Node): boolean => {
  if (node.type === 'TaggedTemplateExpression') {
    return true;
  }

  return getOxcNodeChildren(node).some(containsTaggedTemplateExpression);
};

export const parseOxc = (code: string, filename: string): Program => {
  return parseOxcProgram(code, filename, 'unambiguous');
};

const toSpanKey = (start: number, end: number): string => `${start}:${end}`;

export const createSpanLookup = (spans?: ExpressionSpan[]): SpanLookup => {
  if (!spans || spans.length === 0) {
    return null;
  }

  return new Set(spans.map((span) => toSpanKey(span.start, span.end)));
};

const matchesSpanLookup = (
  node: Pick<Node, 'start' | 'end'>,
  spanLookup: SpanLookup
): boolean => !spanLookup || spanLookup.has(toSpanKey(node.start, node.end));

export const getSourceLocation = (
  start: number,
  end: number,
  ctx: Pick<ExtractionContext, 'filename' | 'loc'>
): SourceLocation => createOxcSourceLocation(start, end, ctx.loc, ctx.filename);

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

export const isInTypeContext = (ancestors: Node[]): boolean =>
  ancestors.some(
    (ancestor) =>
      ancestor.type.startsWith('TS') || ancestor.type.startsWith('JSDoc')
  );

export const isPropertyOnlyIdentifier = (
  node: Node,
  parent: Node | null
): boolean =>
  !!parent &&
  parent.type === 'MemberExpression' &&
  parent.property === node &&
  !parent.computed;

export const isObjectPropertyKey = (node: Node, parent: Node | null): boolean =>
  !!parent &&
  parent.type === 'Property' &&
  parent.key === node &&
  !parent.computed &&
  parent.value !== node;

export const isBindingPosition = (node: Node, parent: Node | null): boolean => {
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
    getOxcNodeChildren(currentNode).forEach((child) =>
      visitNode(child, nextScope, currentNode)
    );
    ancestors.pop();
  };

  visitNode(node, scope, parent);
};

export const analyzeProgram = (
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

export const resolveBindingAt = (
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

export const findReferences = (
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

export const isBindingDeclaredWithin = (
  binding: Binding,
  container: Node
): boolean =>
  container.start <= binding.declaredAt && binding.declaredAt < container.end;
