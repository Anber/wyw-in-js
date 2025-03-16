import type { NodePath } from '@babel/core';
import { types as t } from '@babel/core';
import type { Identifier, Program } from '@babel/types';

import type { CodeRemoverOptions } from '@wyw-in-js/shared';
import { nonType } from './findIdentifiers';
import { isUnnecessaryReactCall } from './isUnnecessaryReactCall';
import { applyAction, removeWithRelated } from './scopeHelpers';
import { JSXElementsRemover } from './visitors/JSXElementsRemover';
import type { IImport } from './collectExportsAndImports';
import { collectExportsAndImports } from './collectExportsAndImports';

const isGlobal = (id: NodePath<Identifier>): boolean => {
  if (!nonType(id)) {
    return false;
  }

  const { scope } = id;
  const { name } = id.node;
  return !scope.hasBinding(name) && scope.hasGlobal(name);
};

const ssrCheckFields = new Set([
  'document',
  'location',
  'navigator',
  'sessionStorage',
  'localStorage',
  'window',
]);

const forbiddenGlobals = new Set([
  ...ssrCheckFields,
  '$RefreshReg$',
  'XMLHttpRequest',
  'clearImmediate',
  'clearInterval',
  'clearTimeout',
  'fetch',
  'navigator',
  'setImmediate',
  'setInterval',
  'setTimeout',
]);

const isBrowserGlobal = (id: NodePath<Identifier>) => {
  return forbiddenGlobals.has(id.node.name) && isGlobal(id);
};

const isSSRCheckField = (id: NodePath<Identifier>) => {
  return ssrCheckFields.has(id.node.name) && isGlobal(id);
};

const getPropertyName = (path: NodePath): string | null => {
  if (path.isIdentifier()) {
    return path.node.name;
  }

  if (path.isStringLiteral()) {
    return path.node.value;
  }

  return null;
};

const getImport = (path: NodePath): [string, string] | undefined => {
  const programPath = path.findParent((p) => p.isProgram()) as
    | NodePath<Program>
    | undefined;
  if (!programPath) {
    return undefined;
  }

  const { imports } = collectExportsAndImports(programPath);

  // We are looking for either Identifier or TSQualifiedName in path
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    const matched =
      binding &&
      imports.find(
        (imp): imp is IImport =>
          imp.imported !== 'side-effect' && binding.path.isAncestor(imp.local)
      );

    if (matched) {
      return [matched.source, matched.imported];
    }
  }

  return undefined;
};

const getTypeImport = (path: NodePath): [string, string] | undefined => {
  // We are looking for either Identifier or TSQualifiedName in path
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (!binding) {
      return undefined;
    }

    if (
      !binding.path.isImportSpecifier() ||
      !binding.path.parentPath.isImportDeclaration()
    ) {
      return undefined;
    }

    const importDeclaration = binding.path.parentPath;
    const imported = binding.path.get('imported');
    const source = importDeclaration.node.source.value;
    const importedNode = imported.node;
    return [
      source,
      t.isIdentifier(importedNode) ? importedNode.name : importedNode.value,
    ];
  }

  if (path.isTSQualifiedName()) {
    const leftPath = path.get('left');
    if (!leftPath.isIdentifier()) {
      // Nested type. Not supported yet.
      return undefined;
    }

    const rightPath = path.get('right');

    const binding = path.scope.getBinding(leftPath.node.name);
    if (!binding) {
      return undefined;
    }

    if (
      (!binding.path.isImportDefaultSpecifier() &&
        !binding.path.isImportNamespaceSpecifier()) ||
      !binding.path.parentPath.isImportDeclaration()
    ) {
      return undefined;
    }

    return [binding.path.parentPath.node.source.value, rightPath.node.name];
  }

  return undefined;
};

const isTypeMatch = (
  id: NodePath<Identifier>,
  types: Record<string, string[]>
): boolean => {
  const typeAnnotation = id.get('typeAnnotation');
  if (!typeAnnotation.isTSTypeAnnotation()) {
    return false;
  }

  const typeReference = typeAnnotation.get('typeAnnotation');
  if (!typeReference.isTSTypeReference()) {
    return false;
  }

  const typeName = typeReference.get('typeName');
  const matchedImport = getTypeImport(typeName);
  return (
    matchedImport !== undefined &&
    matchedImport[0] in types &&
    types[matchedImport[0]].includes(matchedImport[1])
  );
};

export const removeDangerousCode = (
  programPath: NodePath<Program>,
  options?: CodeRemoverOptions
) => {
  const componentTypes = options?.componentTypes ?? {
    react: [
      'ExoticComponent',
      'FC',
      'ForwardRefExoticComponent',
      'FunctionComponent',
      'LazyExoticComponent',
      'MemoExoticComponent',
      'NamedExoticComponent',
    ],
  };

  programPath.traverse(
    {
      // JSX can be replaced with a dummy value,
      // but we have to do it after we processed template tags.
      CallExpression: {
        enter(p) {
          if (isUnnecessaryReactCall(p)) {
            JSXElementsRemover(p);
          }
        },
      },
      JSXElement: {
        enter: JSXElementsRemover,
      },
      JSXFragment: {
        enter: JSXElementsRemover,
      },
      MemberExpression(p, state) {
        const obj = p.get('object');
        const prop = p.get('property');
        if (!obj.isIdentifier({ name: 'window' })) {
          return;
        }

        const name = getPropertyName(prop);
        if (!name) {
          return;
        }

        state.windowScoped.add(name);
        // eslint-disable-next-line no-param-reassign
        state.globals = state.globals.filter((id) => {
          if (id.node.name === name) {
            removeWithRelated([id]);
            return false;
          }

          return true;
        });
      },
      MetaProperty(p) {
        // Remove all references to `import.meta`
        removeWithRelated([p]);
      },
      Identifier(p, state) {
        if (p.find((parent) => parent.isTSTypeReference())) {
          // don't mess with TS type references
          return;
        }
        if (isBrowserGlobal(p)) {
          if (
            p.find(
              (parentPath) =>
                parentPath.isUnaryExpression({ operator: 'typeof' }) ||
                parentPath.isTSTypeQuery()
            )
          ) {
            // Ignore `typeof window` expressions
            return;
          }

          if (p.parentPath.isClassProperty()) {
            // ignore class property decls
            return;
          }
          if (p.parentPath.isMemberExpression() && p.key === 'property') {
            // ignore e.g this.fetch()
            // window.fetch will be handled by the windowScoped block below
            return;
          }

          removeWithRelated([p]);

          return;
        }

        if (state.windowScoped.has(p.node.name)) {
          removeWithRelated([p]);
        } else if (isGlobal(p)) {
          state.globals.push(p);
        }
      },

      // Since we can use happy-dom, typical SSR checks may not work as expected.
      // We need to detect them and replace with an "undefined" literal.
      UnaryExpression(p) {
        if (p.node.operator !== 'typeof') {
          return;
        }
        const arg = p.get('argument');
        if (!arg.isIdentifier() || !isSSRCheckField(arg)) {
          return;
        }

        applyAction([
          'replace',
          p,
          { type: 'StringLiteral', value: 'undefined' },
        ]);
      },
      VariableDeclarator(p) {
        const id = p.get('id');
        const init = p.get('init');
        if (
          id.isIdentifier() &&
          isTypeMatch(id, componentTypes) &&
          init.isExpression()
        ) {
          // Variable is typed as a React component. We can replace its value with a null-function.
          applyAction([
            'replace',
            init,
            t.arrowFunctionExpression([], t.nullLiteral()),
          ]);
        }
      },
    },
    {
      globals: [] as NodePath<Identifier>[],
      windowScoped: new Set<string>(),
    }
  );
};
