/* eslint @typescript-eslint/no-use-before-define: ["error", { "functions": false }] */
/* eslint-disable no-restricted-syntax,no-continue */

import type { NodePath } from '@babel/traverse';
import type {
  CallExpression,
  ExportAllDeclaration,
  ExportDefaultDeclaration,
  ExportDefaultSpecifier,
  ExportNamedDeclaration,
  ExportNamespaceSpecifier,
  ExportSpecifier,
  Identifier,
  Import,
  ImportDeclaration,
  ImportDefaultSpecifier,
  ImportNamespaceSpecifier,
  ImportSpecifier,
  MemberExpression,
  ObjectPattern,
  Program,
  StringLiteral,
  VariableDeclarator,
} from '@babel/types';

import { logger } from '@wyw-in-js/shared';

import { getScope } from './getScope';
import { isNotNull } from './isNotNull';
import { isTypedNode } from './isTypedNode';
import { getConstantStringValue } from './getConstantStringValue';
import { getTraversalCache } from './traversalCache';

export interface ISideEffectImport {
  imported: 'side-effect';
  local: NodePath;
  source: string;
}

export interface IImport {
  imported: string | 'default' | '*';
  local: NodePath<Identifier | MemberExpression>;
  source: string;
  type: 'dynamic' | 'esm';
}

export type Exports = Record<string | 'default' | '*', NodePath>; // '*' means re-export all

export interface IReexport {
  exported: string | 'default' | '*';
  imported: string | 'default' | '*';
  local: NodePath;
  source: string;
}

export interface IState {
  deadExports: string[];
  exportRefs: Map<string, NodePath<MemberExpression>[]>;
  exports: Exports;
  imports: (IImport | ISideEffectImport)[];
  isEsModule: boolean;
  reexports: IReexport[];
}

type ILocalState = IState;

export const sideEffectImport = (
  item: IImport | ISideEffectImport
): item is ISideEffectImport => item.imported === 'side-effect';

export const explicitImport = (
  item: IImport | ISideEffectImport
): item is IImport => item.imported !== 'side-effect';

function getValue({ node }: { node: Identifier | StringLiteral }): string {
  return node.type === 'Identifier' ? node.name : node.value;
}

// We ignore imports and exports of types
const isType = (p: {
  node: { importKind?: 'type' | unknown } | { exportKind?: 'type' | unknown };
}): boolean =>
  ('importKind' in p.node && p.node.importKind === 'type') ||
  ('exportKind' in p.node && p.node.exportKind === 'type');

// Force TypeScript to check, that we have implementation for every possible specifier
type SpecifierTypes = ImportDeclaration['specifiers'][number];
const collectors: {
  [K in SpecifierTypes['type']]: (
    path: NodePath<SpecifierTypes & { type: K }>,
    source: string
  ) => IImport[];
} = {
  ImportSpecifier(path: NodePath<ImportSpecifier>, source): IImport[] {
    if (isType(path)) return [];
    const imported = getValue(path.get('imported'));
    const local = path.get('local');
    return [{ imported, local, source, type: 'esm' }];
  },

  ImportDefaultSpecifier(
    path: NodePath<ImportDefaultSpecifier>,
    source
  ): IImport[] {
    const local = path.get('local');
    return [{ imported: 'default', local, source, type: 'esm' }];
  },

  ImportNamespaceSpecifier(
    path: NodePath<ImportNamespaceSpecifier>,
    source
  ): IImport[] {
    const local = path.get('local');
    return unfoldNamespaceImport({ imported: '*', local, source, type: 'esm' });
  },
};

function collectFromImportDeclaration(
  path: NodePath<ImportDeclaration>,
  state: ILocalState
): void {
  // If importKind is specified, and it's not a value, ignore that import
  if (isType(path)) return;

  const source = getValue(path.get('source'));
  const specifiers = path.get('specifiers');

  if (specifiers.length === 0) {
    state.imports.push({ imported: 'side-effect', local: path, source });
  }

  specifiers.forEach(<T extends SpecifierTypes>(specifier: NodePath<T>) => {
    if (specifier.isImportSpecifier() && isType(specifier)) return;

    const collector = collectors[
      specifier.node.type
    ] as (typeof collectors)[T['type']];

    state.imports.push(...collector(specifier, source));
  });
}

interface IDestructed {
  as: NodePath<Identifier>;
  what: string | '*';
}

function getAncestorsWhile(path: NodePath, cond: (p: NodePath) => boolean) {
  const result: NodePath[] = [];
  let current: NodePath | null = path;
  while (current && cond(current)) {
    result.push(current);
    current = current.parentPath;
  }

  return result;
}

function whatIsDestructed(
  objectPattern: NodePath<ObjectPattern>
): IDestructed[] {
  const destructedProps: IDestructed[] = [];
  objectPattern.traverse({
    Identifier(identifier) {
      if (identifier.isBindingIdentifier()) {
        const parent = identifier.parentPath;
        if (parent.isObjectProperty({ value: identifier.node })) {
          const chain = getAncestorsWhile(parent, (p) => p !== objectPattern)
            .filter(isTypedNode('ObjectProperty'))
            .map((p) => {
              const key = p.get('key');
              if (!key.isIdentifier()) {
                // TODO: try to process other type of keys or at least warn about this
                return null;
              }

              return key;
            })
            .filter(isNotNull);
          chain.reverse();

          if (chain.length > 0) {
            destructedProps.push({
              what: chain[0].node.name,
              as: identifier,
            });
          }

          return;
        }

        if (parent.isRestElement({ argument: identifier.node })) {
          destructedProps.push({
            what: '*',
            as: identifier,
          });
        }
      }
    },
  });

  return destructedProps;
}

const debug = logger.extend('evaluator:collectExportsAndImports');

function importFromVariableDeclarator(
  path: NodePath<VariableDeclarator>,
  isSync: boolean
): IDestructed[] {
  const id = path.get('id');
  if (id.isIdentifier()) {
    // It's the simplest case when the full namespace is imported
    return [
      {
        as: id,
        what: '*',
      },
    ];
  }

  if (!isSync) {
    // Something went wrong
    // Is it something like `const { … } = import(…)`?
    debug('`import` should be awaited');
    return [];
  }

  if (id.isObjectPattern()) {
    return whatIsDestructed(id);
  }

  // What else it can be?
  debug('importFromVariableDeclarator: unknown type of id %o', id.node.type);

  return [];
}

const findIIFE = (path: NodePath): NodePath<CallExpression> | null => {
  if (path.isCallExpression() && path.get('callee').isFunctionExpression()) {
    return path;
  }

  if (!path.parentPath) {
    return null;
  }

  return findIIFE(path.parentPath);
};

function exportFromVariableDeclarator(
  path: NodePath<VariableDeclarator>
): Exports {
  const id = path.get('id');
  const init = path.get('init');

  // If there is no init and id is an identifier, we should find IIFE
  if (!init.node && id.isIdentifier()) {
    const binding = getScope(path).getBinding(id.node.name);
    if (!binding) {
      return {};
    }

    const iife = [
      ...binding.referencePaths,
      ...binding.constantViolations,
      binding.path,
    ]
      .map(findIIFE)
      .find(isNotNull);

    if (!iife) {
      return {};
    }

    return {
      [id.node.name]: iife,
    };
  }

  if (!init || !init.isExpression()) {
    return {};
  }

  if (id.isIdentifier()) {
    // It is `export const a = 1;`
    return {
      [id.node.name]: init,
    };
  }

  if (id.isObjectPattern()) {
    // It is `export const { a, ...rest } = obj;`
    return whatIsDestructed(id).reduce<Exports>(
      (acc, destructed) => ({
        ...acc,
        [destructed.as.node.name]: init,
      }),
      {}
    );
  }

  if (id.isArrayPattern()) {
    // It is `export const [a, , b, ...rest] = arr;`
    const exported = new Set<string>();
    id.traverse({
      Identifier(identifier) {
        if (identifier.isBindingIdentifier()) {
          exported.add(identifier.node.name);
        }
      },
    });

    if (exported.size === 0) {
      return {};
    }

    const result: Exports = {};
    exported.forEach((name) => {
      result[name] = init;
    });

    return result;
  }

  // What else it can be?
  debug('exportFromVariableDeclarator: unknown type of id %o', id.node.type);

  return {};
}

function collectFromDynamicImport(
  path: NodePath<Import>,
  state: ILocalState
): void {
  const { parentPath: callExpression } = path;
  if (!callExpression.isCallExpression()) {
    // It's wrong `import`
    return;
  }

  const [sourcePath] = callExpression.get('arguments');
  if (!sourcePath || !sourcePath.isExpression()) {
    // Import should have at least one argument
    return;
  }

  const source = getConstantStringValue(sourcePath.node);
  if (source === null) {
    return;
  }

  let { parentPath: container, key } = callExpression;
  let isAwaited = false;

  if (container.isAwaitExpression()) {
    // If it's not awaited import, it imports the full namespace
    isAwaited = true;
    key = container.key;
    container = container.parentPath!;
  }

  // Is it `const something = await import("something")`?
  if (key === 'init' && container.isVariableDeclarator()) {
    importFromVariableDeclarator(container, isAwaited).map((prop) =>
      state.imports.push({
        imported: prop.what,
        local: prop.as,
        source,
        type: 'dynamic',
      })
    );
  }
}

function collectFromWywDynamicImport(
  path: NodePath<Identifier>,
  state: ILocalState
): void {
  if (!path.isIdentifier({ name: '__wyw_dynamic_import' })) {
    return;
  }

  const { parentPath: callExpression } = path;
  if (!callExpression.isCallExpression()) {
    return;
  }

  const [sourcePath] = callExpression.get('arguments');
  if (!sourcePath || !sourcePath.isExpression()) {
    return;
  }

  const source = getConstantStringValue(sourcePath.node);
  if (source === null) {
    return;
  }

  let { parentPath: container, key } = callExpression;
  let isAwaited = false;

  if (container.isAwaitExpression()) {
    // If it's not awaited import, it imports the full namespace
    isAwaited = true;
    key = container.key;
    container = container.parentPath!;
  }

  // Is it `const something = await __wyw_dynamic_import("something")`?
  if (key === 'init' && container.isVariableDeclarator()) {
    importFromVariableDeclarator(container, isAwaited).forEach((prop) => {
      if (prop.what === '*') {
        const unfolded = unfoldNamespaceImport({
          imported: '*',
          local: prop.as,
          source,
          type: 'dynamic',
        });

        state.imports.push(...unfolded);
        return;
      }

      state.imports.push({
        imported: prop.what,
        local: prop.as,
        source,
        type: 'dynamic',
      });
    });

    return;
  }

  state.imports.push({
    imported: '*',
    local: path,
    source,
    type: 'dynamic',
  });
}

function unfoldNamespaceImport(
  importItem: IImport & { imported: '*' }
): IImport[] {
  const result: IImport[] = [];
  const { local } = importItem;
  if (!local.isIdentifier()) {
    // TODO: handle it
    return [importItem];
  }

  const binding = getScope(local).getBinding(local.node.name);
  if (!binding?.referenced) {
    // Imported namespace is not referenced and probably not used,
    // but it can have side effects, so we should keep it as is
    return [
      {
        ...importItem,
        imported: 'side-effect',
      },
    ];
  }

  for (const referencePath of binding?.referencePaths ?? []) {
    if (
      referencePath.find(
        (ancestor) => ancestor.isTSType() || ancestor.isFlowType()
      )
    ) {
      continue;
    }

    const { parentPath } = referencePath;
    if (parentPath?.isMemberExpression() && referencePath.key === 'object') {
      const property = parentPath.get('property');
      const object = parentPath.get('object');
      let imported: string | null;
      if (parentPath.node.computed && property.isStringLiteral()) {
        imported = property.node.value;
      } else if (!parentPath.node.computed && property.isIdentifier()) {
        imported = property.node.name;
      } else {
        imported = null;
      }

      if (object.isIdentifier() && imported) {
        result.push({
          ...importItem,
          imported,
          local: parentPath,
        });
      } else {
        result.push(importItem);
        break;
      }

      continue;
    }

    if (parentPath?.isVariableDeclarator() && referencePath.key === 'init') {
      importFromVariableDeclarator(parentPath, true).map((prop) =>
        result.push({ ...importItem, imported: prop.what, local: prop.as })
      );

      continue;
    }

    if (
      parentPath?.isCallExpression() &&
      referencePath.listKey === 'arguments'
    ) {
      // Namespace is used as a call argument; assume full namespace is needed.
      result.push(importItem);
      break;
    }

    if (
      parentPath?.isExportSpecifier() ||
      parentPath?.isExportDefaultDeclaration()
    ) {
      // The whole namespace is re-exported
      result.push(importItem);
      break;
    }

    // Otherwise, we can't predict usage and import it as is
    // TODO: handle more cases
    debug(
      'unfoldNamespaceImports: unknown reference %o',
      referencePath.node.type
    );
    result.push(importItem);
    break;
  }

  return result;
}

function collectFromExportAllDeclaration(
  path: NodePath<ExportAllDeclaration>,
  state: ILocalState
): void {
  if (isType(path)) return;
  const source = path.get('source')?.node?.value;
  if (!source) return;

  // It is `export * from './css';`
  state.reexports.push({
    exported: '*',
    imported: '*',
    local: path,
    source,
  });
}

function collectFromExportSpecifier(
  path: NodePath<
    ExportSpecifier | ExportDefaultSpecifier | ExportNamespaceSpecifier
  >,
  source: string | undefined,
  state: ILocalState
): void {
  if (path.isExportSpecifier()) {
    const exported = getValue(path.get('exported'));
    if (source) {
      // It is `export { foo } from './css';`
      const imported = path.get('local').node.name;
      state.reexports.push({
        exported,
        imported,
        local: path,
        source,
      });
    } else {
      const local = path.get('local');
      // eslint-disable-next-line no-param-reassign
      state.exports[exported] = local;
    }

    return;
  }

  if (path.isExportDefaultSpecifier() && source) {
    // It is `export default from './css';`
    state.reexports.push({
      exported: 'default',
      imported: 'default',
      local: path,
      source,
    });
  }

  if (path.isExportNamespaceSpecifier() && source) {
    const exported = path.get('exported').node.name;
    // It is `export * as foo from './css';`
    state.reexports.push({
      exported,
      imported: '*',
      local: path,
      source,
    });
  }

  // TODO: handle other cases
  debug(
    'collectFromExportSpecifier: unprocessed ExportSpecifier %o',
    path.node.type
  );
}

function collectFromExportNamedDeclaration(
  path: NodePath<ExportNamedDeclaration>,
  state: ILocalState
): void {
  if (isType(path)) return;

  const source = path.get('source')?.node?.value;
  const specifiers = path.get('specifiers');
  if (specifiers) {
    specifiers.forEach((specifier) =>
      collectFromExportSpecifier(specifier, source, state)
    );
  }

  const declaration = path.get('declaration');
  if (declaration.isVariableDeclaration()) {
    declaration.get('declarations').forEach((declarator) => {
      // eslint-disable-next-line no-param-reassign
      state.exports = {
        ...state.exports,
        ...exportFromVariableDeclarator(declarator),
      };
    });
  }

  if (declaration.isTSEnumDeclaration()) {
    // eslint-disable-next-line no-param-reassign
    state.exports[declaration.get('id').node.name] = declaration;
  }

  if (declaration.isFunctionDeclaration()) {
    const id = declaration.get('id');
    if (id.isIdentifier()) {
      // eslint-disable-next-line no-param-reassign
      state.exports[id.node.name] = id;
    }
  }

  if (declaration.isClassDeclaration()) {
    const id = declaration.get('id');
    if (id.isIdentifier()) {
      // eslint-disable-next-line no-param-reassign
      state.exports[id.node.name] = id;
    }
  }
}

function collectFromExportDefaultDeclaration(
  path: NodePath<ExportDefaultDeclaration>,
  state: ILocalState
): void {
  if (isType(path)) return;

  // eslint-disable-next-line no-param-reassign
  state.exports.default = path.get('declaration');
}

export function collectExportsAndImports(
  path: NodePath<Program>,
  cacheMode: 'disabled' | 'force' | 'enabled' = 'enabled'
): IState {
  const localState: ILocalState = {
    deadExports: [],
    exportRefs: new Map(),
    exports: {},
    imports: [],
    reexports: [],
    isEsModule: path.node.sourceType === 'module',
  };

  const cache =
    cacheMode !== 'disabled'
      ? getTraversalCache<IState>(path, 'collectExportsAndImports')
      : undefined;

  if (cacheMode === 'enabled' && cache?.has(path)) {
    return cache.get(path) ?? localState;
  }

  path.traverse(
    {
      ExportAllDeclaration: collectFromExportAllDeclaration,
      ExportDefaultDeclaration: collectFromExportDefaultDeclaration,
      ExportNamedDeclaration: collectFromExportNamedDeclaration,
      ImportDeclaration: collectFromImportDeclaration,
      Import: collectFromDynamicImport,
      Identifier: collectFromWywDynamicImport,
    },
    localState
  );

  cache?.set(path, localState);

  return localState;
}
