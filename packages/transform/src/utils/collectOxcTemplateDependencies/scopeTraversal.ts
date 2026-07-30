/* eslint-disable no-continue,@typescript-eslint/no-use-before-define */

import type { Node } from 'oxc-parser';

import {
  isInOxcTypeContext,
  isOxcBindingPosition,
  isOxcObjectPropertyKey,
  isOxcPropertyOnlyIdentifier,
  visitOxcLexicalScopes,
  type OxcLexicalScopeBoundary,
} from '../oxc/lexicalScopes';
import { collectOxcPatternBindingNames } from '../oxc/patterns';
import { isOxcFunctionLike } from '../oxc/runtimeSemantics';
import type { Binding, ReferenceIdentifier, Scope } from './types';

const createScope = (
  parent: Scope | null,
  boundary: OxcLexicalScopeBoundary
): Scope => ({
  bindings: new Map(),
  depth: parent ? parent.depth + 1 : 0,
  end: boundary.end,
  functionBoundary: boundary.functionBoundary,
  params: new Set(),
  parent,
  root: boundary.root,
  start: boundary.start,
});

export const isInTypeContext = isInOxcTypeContext;
export const isPropertyOnlyIdentifier = isOxcPropertyOnlyIdentifier;
export const isObjectPropertyKey = isOxcObjectPropertyKey;
export const isBindingPosition = isOxcBindingPosition;

export const visitOxcScopes = (
  node: Node,
  scope: Scope | null,
  enter: (
    node: Node,
    scope: Scope,
    parent: Node | null,
    ancestors: Node[],
    runtime: boolean,
    reference: boolean
  ) => void
): void => {
  visitOxcLexicalScopes(
    node,
    scope,
    createScope,
    (current, currentScope, parent, ancestors, runtime, reference) => {
      if (current.type === 'FunctionExpression' && current.id) {
        currentScope.bindings.set(current.id.name, {
          declaredAt: current.start,
          declaration: null,
          declarator: null,
          functionNode: current,
          isRoot: false,
          kind: 'function',
          name: current.id.name,
          scope: currentScope,
        });
      }

      if (current.type === 'ClassExpression' && current.id) {
        currentScope.bindings.set(current.id.name, {
          declarationKind: 'let',
          declaredAt: current.start,
          declaration: null,
          declarator: null,
          functionNode: null,
          isRoot: false,
          kind: 'variable',
          name: current.id.name,
          scope: currentScope,
        });
      }

      if (isOxcFunctionLike(current)) {
        current.params.forEach((param) => {
          collectOxcPatternBindingNames(param).forEach((name) => {
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

      if (current.type === 'CatchClause' && current.param) {
        collectOxcPatternBindingNames(current.param).forEach((name) => {
          currentScope.bindings.set(name, {
            declarationKind: 'let',
            declaredAt: current.param!.start,
            declaration: null,
            declarator: null,
            functionNode: null,
            isRoot: false,
            kind: 'variable',
            name,
            scope: currentScope,
          });
        });
      }

      enter(current, currentScope, parent, ancestors, runtime, reference);
    }
  );
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

  visitOxcScopes(
    node,
    null,
    (current, scope, _parent, _ancestors, _runtime, reference) => {
      if (
        !reference ||
        current.type !== 'Identifier' ||
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
    }
  );

  const resolvedReferences = [...refs.values()];
  referenceCache?.set(node, resolvedReferences);
  return resolvedReferences;
};

export const isBindingDeclaredWithin = (
  binding: Binding,
  container: Node
): boolean =>
  container.start <= binding.declaredAt && binding.declaredAt < container.end;
