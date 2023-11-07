/* eslint @typescript-eslint/no-use-before-define: ["error", { "functions": false }] */
/* eslint-disable no-restricted-syntax,no-continue */

import type { NodePath } from '@babel/traverse';
import type {
  ArrayExpression,
  AssignmentExpression,
  BlockStatement,
  CallExpression,
  ExportAllDeclaration,
  ExportDefaultDeclaration,
  ExportDefaultSpecifier,
  ExportNamedDeclaration,
  ExportNamespaceSpecifier,
  ExportSpecifier,
  Expression,
  Function as FunctionNode,
  Identifier,
  Import,
  ImportDeclaration,
  ImportDefaultSpecifier,
  ImportNamespaceSpecifier,
  ImportSpecifier,
  MemberExpression,
  ObjectExpression,
  ObjectPattern,
  Program,
  StringLiteral,
  VariableDeclarator,
} from '@babel/types';

import { logger } from '@wyw-in-js/shared';

import { getScope } from './getScope';
import { isExports } from './isExports';
import { isNotNull } from './isNotNull';
import { isRequire } from './isRequire';
import { isTypedNode } from './isTypedNode';
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
  type: 'cjs' | 'dynamic' | 'esm';
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

interface ILocalState extends IState {
  processedRequires: WeakSet<NodePath>;
}

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
  if (!sourcePath || !sourcePath.isStringLiteral()) {
    // Import should have at least one argument, and it should be StringLiteral
    return;
  }

  const source = sourcePath.node.value;

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

function getCalleeName(path: NodePath<CallExpression>): string | undefined {
  const callee = path.get('callee');
  if (callee.isIdentifier()) {
    return callee.node.name;
  }

  if (callee.isMemberExpression()) {
    const property = callee.get('property');
    if (property.isIdentifier()) {
      return property.node.name;
    }
  }

  return undefined;
}

type MatchRule = [
  name: string,
  ...args: (NodePath | '*' | ((p: NodePath) => boolean))[],
];

const matchCall = (p: NodePath<CallExpression>, rules: MatchRule[]) => {
  const name = getCalleeName(p);

  if (name === undefined) {
    return false;
  }

  return rules.some(([n, ...args]) => {
    if (name !== n) return false;
    const fnArgs = p.get('arguments');
    if (fnArgs.length !== args.length) return false;
    return args.every((arg, i) => {
      if (arg === '*') return true;
      if (typeof arg === 'function') return arg(fnArgs[i]);
      return arg === fnArgs[i];
    });
  });
};

function getImportExportTypeByInteropFunction(
  path: NodePath<CallExpression>,
  argPath: NodePath
): 'import:*' | 're-export:*' | 'default' | undefined {
  if (matchCall(path, [['__exportStar', argPath, (p) => isExports(p)]])) {
    return 're-export:*';
  }

  if (
    matchCall(path, [
      ['_interopRequireDefault', argPath], // babel and swc <1.3.50
      ['_interop_require_default', argPath], // swc >=1.3.50
      ['__importDefault', argPath], // ?
    ])
  ) {
    return 'default';
  }

  if (
    matchCall(path, [
      ['_interopRequireWildcard', argPath], // babel and swc <1.3.50
      ['_interop_require_wildcard', argPath], // swc >=1.3.50
      ['__importStar', argPath], // ?
      ['__toESM', argPath], // esbuild >=0.14.7
      ['__toModule', argPath], // esbuild <0.14.7
    ])
  ) {
    return 'import:*';
  }

  if (
    matchCall(path, [
      ['_extends', isEmptyObject, argPath], // babel and swc
      ['__rest', argPath, isArrayExpression], // tsc and esbuild <=0.11.3
      ['__objRest', argPath, isArrayExpression], // esbuild >0.11.3
      ['_objectWithoutProperties', argPath, isArrayExpression], // babel and swc <1.3.50
      ['_object_without_properties', argPath, isArrayExpression], // swc >=1.3.50
      ['_objectDestructuringEmpty', argPath], // swc <1.3.50
      ['_object_destructuring_empty', argPath], // swc >=1.3.50
    ])
  ) {
    return 'import:*';
  }

  return undefined;
}

function isAlreadyProcessed(path: NodePath): boolean {
  if (
    path.isCallExpression() &&
    path.get('callee').isIdentifier({ name: '__toCommonJS' })
  ) {
    // because its esbuild and we already processed all exports
    return true;
  }

  return false;
}

function isRequireCall(path: NodePath): path is NodePath<CallExpression> {
  return path.isCallExpression() && isRequire(path.get('callee'));
}

function isEmptyObject(path: NodePath): path is NodePath<ObjectExpression> {
  return path.isObjectExpression() && path.node.properties.length === 0;
}

function isArrayExpression(path: NodePath): path is NodePath<ArrayExpression> {
  return path.isArrayExpression();
}

function isCallExpression(path: NodePath): path is NodePath<CallExpression>;
function isCallExpression(
  calleeName: string
): (path: NodePath) => path is NodePath<CallExpression>;
function isCallExpression(pathOrName: NodePath | string) {
  if (typeof pathOrName === 'string') {
    return (p: NodePath) =>
      p.isCallExpression() &&
      p.get('callee').isIdentifier({ name: pathOrName });
  }

  return pathOrName.isCallExpression();
}

function isObjectExpression(
  path: NodePath
): path is NodePath<ObjectExpression> {
  return path.isObjectExpression();
}

function isIdentifier(name: string) {
  return (path: NodePath): path is NodePath<Identifier> =>
    path.isIdentifier({ name });
}

function collectFromRequire(
  path: NodePath<Identifier>,
  state: ILocalState
): void {
  if (!isRequire(path)) return;

  // This method can be reached many times from multiple visitors for the same path
  // So we need to check if we already processed it
  if (state.processedRequires.has(path)) return;
  state.processedRequires.add(path);

  const { parentPath: callExpression } = path;
  if (!callExpression.isCallExpression()) {
    // It's wrong `require`
    return;
  }

  const [sourcePath] = callExpression.get('arguments');
  if (!sourcePath || !sourcePath.isStringLiteral()) {
    // Import should have at least one argument, and it should be StringLiteral
    return;
  }

  const source = sourcePath.node.value;

  const { parentPath: container, key } = callExpression;

  if (container.isCallExpression()) {
    // It may be transpiled import such as
    // `var _atomic = _interopRequireDefault(require("@linaria/atomic"));`
    const imported = getImportExportTypeByInteropFunction(
      container,
      callExpression
    );
    if (!imported) {
      // It's not a transpiled import.
      // TODO: Can we guess that it's a namespace import?
      debug('Unknown wrapper of require: %o', container.node.callee);
      return;
    }

    if (imported === 're-export:*') {
      state.reexports.push({
        exported: '*',
        imported: '*',
        local: path,
        source,
      });

      return;
    }

    let { parentPath: variableDeclarator } = container;
    if (variableDeclarator.isCallExpression()) {
      if (variableDeclarator.get('callee').isIdentifier({ name: '_extends' })) {
        variableDeclarator = variableDeclarator.parentPath!;
      }
    }

    if (!variableDeclarator.isVariableDeclarator()) {
      // TODO: Where else it can be?
      debug('Unexpected require inside %o', variableDeclarator.node.type);
      return;
    }

    const id = variableDeclarator.get('id');
    if (!id.isIdentifier()) {
      debug('Id should be Identifier %o', variableDeclarator.node.type);
      return;
    }

    if (imported === 'import:*') {
      const unfolded = unfoldNamespaceImport({
        imported: '*',
        local: id,
        source,
        type: 'cjs',
      });
      state.imports.push(...unfolded);
    } else {
      state.imports.push({
        imported,
        local: id,
        source,
        type: 'cjs',
      });
    }
  }

  if (container.isMemberExpression()) {
    // It is `require('@linaria/shaker').dep`
    const property = container.get('property');
    if (!property.isIdentifier() && !property.isStringLiteral()) {
      debug(
        'Property should be Identifier or StringLiteral %s',
        property.node.type
      );

      return;
    }

    const { parentPath: variableDeclarator } = container;

    if (variableDeclarator.isVariableDeclarator()) {
      // It is `const … = require('@linaria/shaker').dep`;
      const id = variableDeclarator.get('id');
      if (id.isIdentifier()) {
        state.imports.push({
          imported: getValue(property),
          local: id,
          source,
          type: 'cjs',
        });
      } else {
        debug('Id should be Identifier %o', variableDeclarator.node.type);
      }
    } else {
      // Maybe require is passed as an argument to some function?
      // Just use the whole MemberExpression as a local
      state.imports.push({
        imported: getValue(property),
        local: container,
        source,
        type: 'cjs',
      });
    }

    return;
  }

  // Is it `const something = require("something")`?
  if (key === 'init' && container.isVariableDeclarator()) {
    importFromVariableDeclarator(container, true).forEach((prop) => {
      if (prop.what === '*') {
        const unfolded = unfoldNamespaceImport({
          imported: '*',
          local: prop.as,
          source,
          type: 'cjs',
        });

        state.imports.push(...unfolded);
      } else {
        state.imports.push({
          imported: prop.what,
          local: prop.as,
          source,
          type: 'cjs',
        });
      }
    });
  }

  if (container.isExpressionStatement()) {
    // Looks like standalone require
    state.imports.push({
      imported: 'side-effect',
      local: container,
      source,
    });
  }
}

function collectFromVariableDeclarator(
  path: NodePath<VariableDeclarator>,
  state: ILocalState
): void {
  let found = false;
  path.traverse({
    Identifier(identifierPath) {
      if (isRequire(identifierPath)) {
        collectFromRequire(identifierPath, state);
        found = true;
      }
    },
  });

  if (found) {
    path.skip();
  }
}

function isChainOfVoidAssignment(
  path: NodePath<AssignmentExpression>
): boolean {
  const right = path.get('right');
  if (right.isUnaryExpression({ operator: 'void' })) {
    return true;
  }

  if (right.isAssignmentExpression()) {
    return isChainOfVoidAssignment(right);
  }

  return false;
}

function getReturnValue(
  path: NodePath<FunctionNode>
): NodePath<Expression> | undefined {
  if (path.node.params.length !== 0) return undefined;

  const body = path.get('body') as
    | NodePath<BlockStatement>
    | NodePath<Expression>;
  if (body.isExpression()) {
    return body;
  }

  if (body.node.body.length === 1) {
    const returnStatement = body.get('body')?.[0];
    if (!returnStatement.isReturnStatement()) return undefined;
    const argument = returnStatement.get('argument');
    if (!argument.isExpression()) return undefined;
    return argument;
  }

  return undefined;
}

function getGetterValueFromDescriptor(
  descriptor: NodePath<ObjectExpression>
): NodePath<Expression> | undefined {
  const props = descriptor
    .get('properties')
    .filter(isTypedNode('ObjectProperty'));

  const getter = props.find((p) => p.get('key').isIdentifier({ name: 'get' }));
  const value = getter?.get('value');

  if (value?.isFunctionExpression() || value?.isArrowFunctionExpression()) {
    return getReturnValue(value);
  }

  const valueProp = props.find((p) =>
    p.get('key').isIdentifier({ name: 'value' })
  );

  const valueValue = valueProp?.get('value');

  return valueValue?.isExpression() ? valueValue : undefined;
}

function addExport(path: NodePath, exported: string, state: ILocalState): void {
  function getRelatedImport() {
    if (path.isMemberExpression()) {
      const object = path.get('object');
      if (!object.isIdentifier()) {
        return undefined;
      }

      const objectBinding = object.scope.getBinding(object.node.name);
      if (!objectBinding) {
        return undefined;
      }

      if (objectBinding.path.isVariableDeclarator()) {
        collectFromVariableDeclarator(objectBinding.path, state);
      }

      const found = state.imports.find(
        (i) =>
          objectBinding.identifier === i.local.node ||
          objectBinding.referencePaths.some((p) => i.local.isAncestor(p))
      );

      if (!found) {
        return undefined;
      }

      const property = path.get('property');
      let what = '*';
      if (path.node.computed && property.isStringLiteral()) {
        what = property.node.value;
      } else if (!path.node.computed && property.isIdentifier()) {
        what = property.node.name;
      }

      return {
        import: { ...found, local: path },
        what,
      };
    }

    return undefined;
  }

  const relatedImport = getRelatedImport();
  if (relatedImport) {
    // eslint-disable-next-line no-param-reassign
    state.reexports.push({
      local: relatedImport.import.local,
      imported: relatedImport.import.imported,
      source: relatedImport.import.source,
      exported,
    });
  } else {
    // eslint-disable-next-line no-param-reassign
    state.exports[exported] = path;
  }
}

function collectFromExports(
  path: NodePath<Identifier>,
  state: ILocalState
): void {
  if (!isExports(path)) return;

  if (path.parentPath.isMemberExpression({ object: path.node })) {
    // It is `exports.prop = …`
    const memberExpression = path.parentPath;
    const property = memberExpression.get('property');
    if (!property.isIdentifier() || memberExpression.node.computed) {
      return;
    }

    const exportName = property.node.name;

    const saveRef = () => {
      // Save all export.____ usages for later
      if (!state.exportRefs.has(exportName)) {
        state.exportRefs.set(exportName, []);
      }

      state.exportRefs.get(exportName)!.push(memberExpression);
    };

    const assignmentExpression = memberExpression.parentPath;

    if (
      !assignmentExpression.isAssignmentExpression({
        left: memberExpression.node,
      })
    ) {
      // If it's not `exports.prop = …`. Just save it.
      saveRef();
      return;
    }

    const right = assignmentExpression.get('right');

    if (isChainOfVoidAssignment(assignmentExpression)) {
      // It is `exports.foo = void 0`
      return;
    }

    if (exportName === '__esModule') {
      // eslint-disable-next-line no-param-reassign
      state.isEsModule = true;
      return;
    }

    saveRef();
    // eslint-disable-next-line no-param-reassign
    state.exports[property.node.name] = right;

    return;
  }

  if (
    path.parentPath.isCallExpression() &&
    path.parentPath.get('callee').matchesPattern('Object.defineProperty')
  ) {
    const [obj, prop, descriptor] = path.parentPath.get('arguments');
    if (
      obj?.isIdentifier(path.node) &&
      prop?.isStringLiteral() &&
      descriptor?.isObjectExpression()
    ) {
      if (prop.node.value === '__esModule') {
        // eslint-disable-next-line no-param-reassign
        state.isEsModule = true;
      } else {
        /**
         *  Object.defineProperty(exports, "token", {
         *    enumerable: true,
         *    get: function get() {
         *      return _unknownPackage.token;
         *    }
         *  });
         */
        const exported = prop.node.value;
        const local = getGetterValueFromDescriptor(descriptor);
        if (local) {
          addExport(local, exported, state);
        }
      }
    } else if (
      obj?.isIdentifier(path.node) &&
      prop?.isIdentifier() &&
      descriptor?.isObjectExpression()
    ) {
      /**
       *  Object.defineProperty(exports, key, {
       *    enumerable: true,
       *    get: function get() {
       *      return _unknownPackage[key];
       *    }
       *  });
       */
      const local = getGetterValueFromDescriptor(descriptor);
      if (local) {
        addExport(local, '*', state);
      }
    }
  }
}

function collectFromRequireOrExports(
  path: NodePath<Identifier>,
  state: ILocalState
): void {
  if (isRequire(path)) {
    collectFromRequire(path, state);
  } else if (isExports(path)) {
    collectFromExports(path, state);
  }
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
      // The defined variable is used as a function argument. Let's try to figure out what is imported.
      const importType = getImportExportTypeByInteropFunction(
        parentPath,
        referencePath
      );

      if (!importType) {
        // Imported value is used as an unknown function argument,
        // so we can't predict usage and import it as is.
        result.push(importItem);
        break;
      }

      if (importType === 'default') {
        result.push({
          ...importItem,
          imported: 'default',
          local: parentPath.get('id') as NodePath<Identifier>,
        });

        continue;
      }

      if (importType === 'import:*') {
        result.push(importItem);
        break;
      }

      debug('unfoldNamespaceImports: unknown import type %o', importType);

      result.push(importItem);
      continue;
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

function collectFromAssignmentExpression(
  path: NodePath<AssignmentExpression>,
  state: ILocalState
): void {
  if (isChainOfVoidAssignment(path)) {
    return;
  }

  const left = path.get('left');
  const right = path.get('right');

  let exported: IReexport['exported'] | undefined;

  if (left.isMemberExpression() && isExports(left.get('object'))) {
    const property = left.get('property');
    if (!left.node.computed && property.isIdentifier()) {
      exported = property.node.name;
    } else if (left.node.computed && property.isStringLiteral()) {
      exported = property.node.value;
    }
  } else if (isExports(left)) {
    // module.exports = ...
    if (!isAlreadyProcessed(right)) {
      exported = 'default';
    }
  }

  if (!exported) return;

  if (exported === '__esModule') {
    // eslint-disable-next-line no-param-reassign
    state.isEsModule = true;
    return;
  }

  if (!isRequireCall(right)) {
    const relatedImport = state.imports.find((imp) => imp.local === right);
    if (relatedImport) {
      state.reexports.push({
        exported,
        ...relatedImport,
      });
    } else {
      // eslint-disable-next-line no-param-reassign
      state.exports[exported] = right;
    }

    path.skip();
    return;
  }

  const sourcePath = right.get('arguments')?.[0];
  const source = sourcePath.isStringLiteral()
    ? sourcePath.node.value
    : undefined;
  if (!source) return;

  // It is `exports.foo = require('./css');`

  if (state.exports[exported]) {
    // eslint-disable-next-line no-param-reassign
    delete state.exports[exported];
  }

  state.reexports.push({
    exported,
    imported: '*',
    local: path,
    source,
  });

  path.skip();
}

function collectAllFromCall(
  path: NodePath<CallExpression>,
  require: number | NodePath,
  state: ILocalState
) {
  const requireCall =
    typeof require === 'number' ? path.get('arguments')[require] : require;
  if (!requireCall.isCallExpression()) return;
  const callee = requireCall.get('callee');
  const sourcePath = requireCall.get('arguments')?.[0];
  if (!isRequire(callee) || !sourcePath.isStringLiteral()) return;

  const source = sourcePath.node.value;
  if (!source) return;

  state.reexports.push({
    exported: '*',
    imported: '*',
    local: path,
    source,
  });

  path.skip();
}

function collectFromMap(map: NodePath<ObjectExpression>, state: ILocalState) {
  const properties = map.get('properties');
  properties.forEach((property) => {
    if (!property.isObjectProperty()) return;
    const key = property.get('key');
    const value = property.get('value');
    if (!key.isIdentifier()) return;
    const exported = key.node.name;

    if (!value.isFunction()) return;
    if (value.node.params.length !== 0) return;

    const returnValue = getReturnValue(value);
    if (!returnValue) return;

    addExport(returnValue, exported, state);
  });
}

function collectMapFromCall(
  path: NodePath<CallExpression>,
  mapPosition: number,
  state: ILocalState
) {
  const map = path.get('arguments')[mapPosition];
  if (!map.isObjectExpression()) return;

  collectFromMap(map, state);

  path.skip();
}

function collectFromEsbuildReExportCall(
  path: NodePath<CallExpression>,
  state: ILocalState
) {
  const [sourceExports, someCall, exports] = path.get('arguments');
  if (
    !sourceExports.isIdentifier({ name: 'source_exports' }) &&
    !isExports(sourceExports)
  )
    return;
  if (!someCall.isCallExpression()) return;

  let requireCall = someCall;
  while (!isRequire(requireCall.get('callee'))) {
    const args = requireCall.get('arguments');
    if (args.length !== 1) {
      return;
    }

    const firstArg = args[0];
    if (!firstArg.isCallExpression()) {
      return;
    }

    requireCall = firstArg;
  }

  if (exports !== undefined && !isExports(exports)) return;

  const sourcePath = requireCall.get('arguments')?.[0];
  if (!sourcePath.isStringLiteral()) return;

  state.reexports.push({
    exported: '*',
    imported: '*',
    local: path,
    source: sourcePath.node.value,
  });

  path.skip();
}

function collectFromCallExpression(
  path: NodePath<CallExpression>,
  state: ILocalState
) {
  const maybeExportStart = path.get('callee');
  if (!maybeExportStart.isIdentifier()) {
    return;
  }

  if (
    matchCall(path, [
      ['__exportStar', isExports, isCallExpression('__toModule')],
    ])
  ) {
    // __exportStar(exports, __toModule(require('…')));

    const secondArg = path.get('arguments')[1] as NodePath<CallExpression>;
    collectAllFromCall(path, secondArg.get('arguments')[0], state);
    return;
  }

  // TypeScript & swc
  if (
    matchCall(path, [
      ['__exportStart', isRequireCall, isExports],
      ['_exportStar', isRequireCall, isExports],
      ['_export_star', isRequireCall, isExports],
      ['__export', isRequireCall], // TypeScript <=3.8.3
    ])
  ) {
    collectAllFromCall(path, 0, state);
    return;
  }

  if (matchCall(path, [['_export', isExports, isObjectExpression]])) {
    collectMapFromCall(path, 1, state);
    return;
  }

  if (
    matchCall(path, [
      ['_extends', isEmptyObject, isRequireCall], // swc <=1.3.16
    ])
  ) {
    collectAllFromCall(path, 1, state);
    return;
  }

  // esbuild
  if (
    matchCall(path, [
      ['__export', isExports, isObjectExpression],
      ['__export', isIdentifier('source_exports'), isObjectExpression],
    ])
  ) {
    collectMapFromCall(path, 1, state);
    return;
  }

  if (
    matchCall(path, [
      // Different variants of re-exports in esbuild
      [
        '__reExport',
        isIdentifier('source_exports'),
        isCallExpression,
        isExports,
      ],
      ['__reExport', isIdentifier('source_exports'), isCallExpression],
      ['__reExport', isExports, isCallExpression],
    ])
  ) {
    collectFromEsbuildReExportCall(path, state);
  }
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
    processedRequires: new WeakSet(),
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
      AssignmentExpression: collectFromAssignmentExpression,
      CallExpression: collectFromCallExpression,
      ExportAllDeclaration: collectFromExportAllDeclaration,
      ExportDefaultDeclaration: collectFromExportDefaultDeclaration,
      ExportNamedDeclaration: collectFromExportNamedDeclaration,
      ImportDeclaration: collectFromImportDeclaration,
      Import: collectFromDynamicImport,
      Identifier: collectFromRequireOrExports,
      VariableDeclarator: collectFromVariableDeclarator,
    },
    localState
  );

  const { processedRequires, ...state } = localState;

  cache?.set(path, state);

  return state;
}
