/* eslint-disable no-continue,@typescript-eslint/no-use-before-define */

import type { Node } from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { collectOxcPatternBindingNames } from '../oxc/patterns';
import {
  isOxcFunctionLike,
  isOxcTypescriptRuntimeWrapper,
} from '../oxc/runtimeSemantics';
import type { Binding, ReferenceIdentifier, Scope } from './types';

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

export const isInTypeContext = (ancestors: Node[]): boolean =>
  ancestors.some(
    (ancestor) =>
      (ancestor.type.startsWith('TS') &&
        !isOxcTypescriptRuntimeWrapper(ancestor)) ||
      ancestor.type.startsWith('JSDoc')
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
  ((parent.type === 'Property' &&
    parent.key === node &&
    !parent.computed &&
    parent.value !== node) ||
    ((parent.type === 'MethodDefinition' ||
      parent.type === 'PropertyDefinition') &&
      parent.key === node &&
      !parent.computed));

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

const isNestedBindingPosition = (
  node: Node,
  ancestors: readonly Node[]
): boolean => {
  let current = node;

  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const parent = ancestors[index]!;
    if (isBindingPosition(current, parent)) {
      return true;
    }

    if (
      (parent.type === 'AssignmentPattern' && parent.left === current) ||
      (parent.type === 'RestElement' && parent.argument === current) ||
      (parent.type === 'Property' && parent.value === current) ||
      (parent.type === 'ObjectPattern' &&
        (parent.properties as readonly Node[]).includes(current)) ||
      (parent.type === 'ArrayPattern' &&
        (parent.elements as readonly (Node | null)[]).includes(current)) ||
      (parent.type === 'TSParameterProperty' && parent.parameter === current)
    ) {
      current = parent;
      continue;
    }

    if (
      (isOxcFunctionLike(parent) &&
        (parent.params as readonly Node[]).includes(current)) ||
      (parent.type === 'CatchClause' && parent.param === current)
    ) {
      return true;
    }

    return false;
  }

  return false;
};

export const visitOxcScopes = (
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
      currentNode.type === 'CatchClause' ||
      currentNode.type === 'ForStatement' ||
      currentNode.type === 'ForInStatement' ||
      currentNode.type === 'ForOfStatement' ||
      currentNode.type === 'SwitchStatement' ||
      currentNode.type === 'StaticBlock' ||
      isOxcFunctionLike(currentNode) ||
      currentNode.type === 'ClassExpression'
    ) {
      let scopeRange: Pick<Node, 'start' | 'end'> = currentNode;
      if (currentNode.type === 'SwitchStatement') {
        scopeRange = {
          end: currentNode.end,
          start: currentNode.cases[0]?.start ?? currentNode.end,
        };
      }
      nextScope = createScope(
        currentScope,
        scopeRange,
        false,
        isOxcFunctionLike(currentNode) || currentNode.type === 'StaticBlock'
      );
    } else if (currentScope) {
      nextScope = currentScope;
    } else {
      nextScope = createScope(null, currentNode, false, true);
    }

    if (currentNode.type === 'FunctionExpression' && currentNode.id) {
      nextScope.bindings.set(currentNode.id.name, {
        declaredAt: currentNode.start,
        declaration: null,
        declarator: null,
        functionNode: currentNode,
        isRoot: false,
        kind: 'function',
        name: currentNode.id.name,
        scope: nextScope,
      });
    }

    if (currentNode.type === 'ClassExpression' && currentNode.id) {
      nextScope.bindings.set(currentNode.id.name, {
        declarationKind: 'let',
        declaredAt: currentNode.start,
        declaration: null,
        declarator: null,
        functionNode: null,
        isRoot: false,
        kind: 'variable',
        name: currentNode.id.name,
        scope: nextScope,
      });
    }

    if (isOxcFunctionLike(currentNode)) {
      currentNode.params.forEach((param) => {
        collectOxcPatternBindingNames(param).forEach((name) => {
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

    if (currentNode.type === 'CatchClause' && currentNode.param) {
      collectOxcPatternBindingNames(currentNode.param).forEach((name) => {
        nextScope.bindings.set(name, {
          declarationKind: 'let',
          declaredAt: currentNode.param!.start,
          declaration: null,
          declarator: null,
          functionNode: null,
          isRoot: false,
          kind: 'variable',
          name,
          scope: nextScope,
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

  visitOxcScopes(node, null, (current, scope, parent, ancestors) => {
    if (
      current.type !== 'Identifier' ||
      isInTypeContext(ancestors) ||
      isNestedBindingPosition(current, ancestors) ||
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
