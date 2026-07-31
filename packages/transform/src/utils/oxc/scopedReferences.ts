import type { Node } from 'oxc-parser';

import {
  visitOxcLexicalScopes,
  type OxcLexicalScopeBoundary,
} from './lexicalScopes';
import { collectOxcPatternIdentifierNames } from './patterns';
import { isOxcFunctionLike } from './runtimeSemantics';

export type OxcScopedBindingPolicy = 'full' | 'minimal';
export type OxcScopedRootPolicy = 'external' | 'local';

type ReferenceScope = {
  activeFrom: number;
  bindings: Set<string>;
  functionBoundary: boolean;
  parent: ReferenceScope | null;
};

type PendingReference = {
  end: number;
  name: string;
  scope: ReferenceScope;
  start: number;
};

const createScope = (
  parent: ReferenceScope | null,
  boundary: OxcLexicalScopeBoundary
): ReferenceScope => ({
  activeFrom:
    boundary.kind === 'switch' ? boundary.start : Number.NEGATIVE_INFINITY,
  bindings: new Set(),
  functionBoundary: boundary.functionBoundary,
  parent,
});

const addPattern = (
  scope: ReferenceScope,
  pattern: Node | null | undefined
): void => {
  collectOxcPatternIdentifierNames(pattern).forEach((binding) =>
    scope.bindings.add(binding)
  );
};

const nearestFunctionScope = (scope: ReferenceScope): ReferenceScope => {
  let current = scope;
  while (!current.functionBoundary && current.parent) {
    current = current.parent;
  }
  return current;
};

export const visitOxcScopedReferences = (
  node: Node,
  bindingPolicy: OxcScopedBindingPolicy,
  rootPolicy: OxcScopedRootPolicy,
  visitor: (name: string, start: number, end: number) => void
): void => {
  const initialScope: ReferenceScope | null =
    node.type === 'Program'
      ? null
      : {
          activeFrom: Number.NEGATIVE_INFINITY,
          bindings: new Set(),
          functionBoundary: true,
          parent: null,
        };
  let rootBindingScope = initialScope;
  const pendingReferences: PendingReference[] = [];
  const fullBindings = bindingPolicy === 'full';

  visitOxcLexicalScopes(
    node,
    initialScope,
    (parent, boundary) => {
      const scope = createScope(parent, boundary);
      if (boundary.root) {
        rootBindingScope = scope;
      }
      return scope;
    },
    (current, currentScope, _parent, _ancestors, _runtime, reference) => {
      if (current.type === 'FunctionExpression' && current.id) {
        addPattern(currentScope, current.id);
      } else if (
        fullBindings &&
        current.type === 'FunctionDeclaration' &&
        current.id
      ) {
        addPattern(currentScope.parent ?? currentScope, current.id);
      }

      if (isOxcFunctionLike(current)) {
        current.params.forEach((parameter) =>
          addPattern(currentScope, parameter)
        );
      }

      if (current.type === 'ClassExpression' && current.id) {
        addPattern(currentScope, current.id);
      } else if (current.type === 'CatchClause') {
        addPattern(currentScope, current.param);
      } else if (fullBindings && current.type === 'VariableDeclaration') {
        const declarationScope =
          current.kind === 'var'
            ? nearestFunctionScope(currentScope)
            : currentScope;
        current.declarations.forEach((declaration) =>
          addPattern(declarationScope, declaration.id)
        );
      } else if (
        fullBindings &&
        (current.type === 'ClassDeclaration' ||
          current.type === 'TSEnumDeclaration') &&
        current.id
      ) {
        addPattern(currentScope, current.id);
      } else if (fullBindings && current.type === 'ImportDeclaration') {
        current.specifiers.forEach((specifier) =>
          addPattern(currentScope, specifier.local)
        );
      }

      if (reference && current.type === 'Identifier') {
        pendingReferences.push({
          end: current.end,
          name: current.name,
          scope: currentScope,
          start: current.start,
        });
      }
    }
  );

  pendingReferences.forEach(({ end, name, scope: referenceScope, start }) => {
    let scope: ReferenceScope | null = referenceScope;
    while (scope && (start < scope.activeFrom || !scope.bindings.has(name))) {
      scope = scope.parent;
    }
    if (!scope || (rootPolicy === 'external' && scope === rootBindingScope)) {
      visitor(name, start, end);
    }
  });
};
