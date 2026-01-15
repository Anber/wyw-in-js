import pathLib from 'path';

import type { BabelFile, PluginObj, NodePath } from '@babel/core';
import type { Binding } from '@babel/traverse';
import type {
  ExportNamedDeclaration,
  Identifier,
  MemberExpression,
  Program,
  VariableDeclarator,
} from '@babel/types';

import { logger, syncResolve } from '@wyw-in-js/shared';
import type { ImportOverride, ImportOverrides } from '@wyw-in-js/shared';

import type { Core } from '../babel';
import type { IMetadata } from '../utils/ShakerMetadata';
import type { Exports, IState } from '../utils/collectExportsAndImports';
import {
  collectExportsAndImports,
  sideEffectImport,
} from '../utils/collectExportsAndImports';
import { getFileIdx } from '../utils/getFileIdx';
import { isRemoved } from '../utils/isRemoved';
import {
  applyAction,
  dereference,
  findActionForNode,
  reference,
  removeWithRelated,
} from '../utils/scopeHelpers';
import { invalidateTraversalCache } from '../utils/traversalCache';
import { stripQueryAndHash } from '../utils/parseRequest';
import { toImportKey } from '../utils/importOverrides';

const warnedDynamicImportFiles = new Set<string>();

export interface IShakerOptions {
  ifUnknownExport?: 'error' | 'ignore' | 'reexport-all' | 'skip-shaking';
  importOverrides?: ImportOverrides;
  keepSideEffects?: boolean;
  onlyExports: string[];
  root?: string;
}

interface NodeWithName {
  name: string;
}

function getNonParamBinding(
  exportPath: NodePath,
  name: string
): Binding | undefined {
  const binding = exportPath.scope.getBinding(name);
  if (binding && (binding.kind as string) !== 'param') {
    return binding;
  }

  // When `exportPath` is inside a function scope, a parameter can shadow
  // the actual export binding (e.g. `export function fallback(fallback) {}`).
  // In such cases we need the binding from the declaration scope.
  return exportPath.scope.parent?.getBinding(name) ?? binding;
}

function getBindingForExport(exportPath: NodePath): Binding | undefined {
  if (exportPath.isIdentifier()) {
    return getNonParamBinding(exportPath, exportPath.node.name);
  }

  const variableDeclarator = exportPath.findParent((p) =>
    p.isVariableDeclarator()
  ) as NodePath<VariableDeclarator> | undefined;
  if (variableDeclarator) {
    const id = variableDeclarator.get('id');
    if (id.isIdentifier()) {
      return variableDeclarator.scope.getBinding(id.node.name);
    }
  }

  if (exportPath.isAssignmentExpression()) {
    const left = exportPath.get('left');
    if (left.isIdentifier()) {
      return getNonParamBinding(exportPath, left.node.name);
    }
  }

  if (exportPath.isFunctionDeclaration() || exportPath.isClassDeclaration()) {
    const { id } = exportPath.node;
    if (!id) {
      // `export default function() {}` / `export default class {}` (anonymous)
      return undefined;
    }
    return getNonParamBinding(exportPath, id.name);
  }

  return undefined;
}

const withoutRemoved = <T extends { local: NodePath }>(items: T[]): T[] =>
  items.filter(({ local }) => !isRemoved(local));

function rearrangeExports(
  { types: t }: Core,
  root: NodePath<Program>,
  exportRefs: Map<string, NodePath<MemberExpression>[]>,
  exports: Exports
): Exports {
  const rearranged = {
    ...exports,
  };

  const rootScope = root.scope;
  exportRefs.forEach((refs, name) => {
    if (refs.length <= 1) {
      if (refs.length === 1) {
        // Maybe exports is assigned to another variable?
        const declarator = refs[0].findParent((p) =>
          p.isVariableDeclarator()
        ) as NodePath<VariableDeclarator> | undefined;

        if (!declarator) {
          return;
        }
      } else {
        return;
      }
    }

    const uid = rootScope.generateUid(name);
    // Define variable in the beginning
    const [declaration] = root.unshiftContainer('body', [
      t.variableDeclaration('var', [t.variableDeclarator(t.identifier(uid))]),
    ]);

    rootScope.registerDeclaration(declaration);

    const constantViolations: NodePath<Identifier>[] = [];
    // Replace every reference with defined variable
    refs.forEach((ref) => {
      const [replaced] = ref.replaceWith(t.identifier(uid));
      if (replaced.isBindingIdentifier()) {
        constantViolations.push(replaced);
      } else {
        reference(replaced);
      }
    });

    constantViolations.forEach((id) => {
      rootScope.registerConstantViolation(id);
    });

    const assigmentToExport = t.expressionStatement(
      t.assignmentExpression(
        '=',
        t.memberExpression(t.identifier('exports'), t.identifier(name)),
        t.identifier(uid)
      )
    );

    // export.foo = _foo will be inserted either after the last _foo assigment or in the end of the file
    const body = root.get('body');
    const lastViolation =
      constantViolations[constantViolations.length - 1] ??
      body[body.length - 1];
    const pathInRoot = root
      .get('body')
      .find((n) => lastViolation.isDescendant(n))!;

    const [pushed] = pathInRoot.insertAfter(assigmentToExport);

    const local = pushed.get('expression.right') as NodePath<Identifier>;
    reference(local);

    rearranged[name] = local;
  });

  return rearranged;
}

const getPropertyAssignmentStatement = (
  ref: NodePath,
  bindingName: string
): NodePath | null => {
  const assignment = ref.findParent((parent) =>
    parent.isAssignmentExpression()
  );
  if (!assignment?.isAssignmentExpression()) return null;

  const left = assignment.get('left');
  if (!left.isMemberExpression()) return null;

  const object = left.get('object');
  if (!object.isIdentifier({ name: bindingName })) return null;

  const statement = assignment.parentPath;
  return statement?.isExpressionStatement() ? statement : null;
};

const isWithinAliveExport = (
  ref: NodePath,
  aliveExports: Set<NodePath>
): boolean =>
  [...aliveExports].some((alive) => alive === ref || alive.isAncestor(ref));

function stripExportKeepDeclaration(path: NodePath): boolean {
  const exportDeclaration = path.findParent((p) =>
    p.isExportNamedDeclaration()
  ) as NodePath<ExportNamedDeclaration> | null;
  if (!exportDeclaration) return false;

  const declaration = exportDeclaration.get('declaration');
  if (!declaration.node) return false;

  if (
    declaration.isFunctionDeclaration() ||
    declaration.isClassDeclaration() ||
    declaration.isTSEnumDeclaration()
  ) {
    exportDeclaration.replaceWith(declaration.node);
    return true;
  }

  if (declaration.isVariableDeclaration()) {
    const declarators = declaration.get('declarations');
    if (declarators.length !== 1) {
      return false;
    }

    exportDeclaration.replaceWith(declaration.node);
    return true;
  }

  return false;
}

export default function shakerPlugin(
  babel: Core,
  {
    keepSideEffects = false,
    ifUnknownExport = 'skip-shaking',
    importOverrides,
    onlyExports,
    root,
  }: IShakerOptions
): PluginObj<IState & { filename: string }> {
  const shakerLogger = logger.extend('shaker');

  return {
    name: '@wyw-in-js/transform/shaker',
    pre(file: BabelFile) {
      this.filename = file.opts.filename!;
      const log = shakerLogger.extend(getFileIdx(this.filename));

      log('start', `${this.filename}, onlyExports: ${onlyExports.join(',')}`);
      const onlyExportsSet = new Set(onlyExports);

      const shouldKeepOverride = (
        override: ImportOverride | undefined
      ): boolean => !!override && ('mock' in override || 'noShake' in override);

      const hasImportOverride = (() => {
        if (!importOverrides || Object.keys(importOverrides).length === 0) {
          return () => false;
        }

        const cache = new Map<string, boolean>();

        return (source: string): boolean => {
          const cached = cache.get(source);
          if (cached !== undefined) {
            return cached;
          }

          const strippedSource = stripQueryAndHash(source);

          const direct =
            importOverrides[source] ??
            (strippedSource !== source
              ? importOverrides[strippedSource]
              : null);
          if (direct) {
            const result = shouldKeepOverride(direct);
            cache.set(source, result);
            return result;
          }

          const isFileImport =
            strippedSource.startsWith('.') ||
            pathLib.isAbsolute(strippedSource);
          if (!isFileImport) {
            cache.set(source, false);
            return false;
          }

          try {
            const resolved = syncResolve(strippedSource, this.filename, []);
            const { key } = toImportKey({
              source: strippedSource,
              resolved,
              root,
            });
            const override = importOverrides[key];
            const result = shouldKeepOverride(override);
            cache.set(source, result);
            return result;
          } catch {
            cache.set(source, false);
            return false;
          }
        };
      })();

      const collected = collectExportsAndImports(file.path);
      const { imports } = collected;
      const sideEffectImports = imports.filter(sideEffectImport);
      log(
        'import-and-exports',
        [
          `imports: ${imports.length} (side-effects: ${sideEffectImports.length})`,
          `exports: ${Object.values(collected.exports).length}`,
          `reexports: ${collected.reexports.length}`,
        ].join(', ')
      );

      // We cannot just throw out exports if they are referred in the code
      // Let's dome some replacements
      const exports = rearrangeExports(
        babel,
        file.path,
        collected.exportRefs,
        collected.exports
      );

      Object.values(exports).forEach((local) => {
        if (local.isAssignmentExpression()) {
          const left = local.get('left');
          if (left.isIdentifier()) {
            // For some reason babel does not mark id in AssignmentExpression as a reference
            // So we need to do it manually
            reference(left, left, true);
          }
        }
      });

      const hasWywPreval = exports.__wywPreval !== undefined;
      const hasDefault = exports.default !== undefined;

      // If __wywPreval is not exported, we can remove it from onlyExports
      if (onlyExportsSet.has('__wywPreval') && !hasWywPreval) {
        onlyExportsSet.delete('__wywPreval');
      }

      if (onlyExportsSet.size === 0) {
        // Fast-lane: if there are no exports to keep, we can just shake out the whole file
        this.imports = [];
        this.exports = {};
        this.reexports = [];
        this.deadExports = Object.keys(exports);

        file.path.get('body').forEach((p) => {
          p.remove();
        });

        return;
      }

      const importedAsSideEffect = onlyExportsSet.has('side-effect');
      onlyExportsSet.delete('side-effect');

      // Hackaround for packages which include a 'default' export without specifying __esModule; such packages cannot be
      // shaken as they will break interopRequireDefault babel helper
      // See example in shaker-plugin.test.ts
      // Real-world example was found in preact/compat npm package
      if (
        onlyExportsSet.has('default') &&
        hasDefault &&
        !collected.isEsModule
      ) {
        this.imports = imports;
        this.exports = exports;
        this.reexports = collected.reexports;
        this.deadExports = [];
        return;
      }

      if (!onlyExportsSet.has('*')) {
        // __esModule should be kept alive
        onlyExportsSet.add('__esModule');

        const aliveExports = new Set<NodePath>();
        const importNames = imports.map(({ imported }) => imported);

        Object.entries(exports).forEach(([exported, local]) => {
          if (onlyExportsSet.has(exported)) {
            aliveExports.add(local);
            return;
          }

          const binding =
            local.isIdentifier() && local.scope.getBinding(local.node.name);

          if (
            binding &&
            (binding.path.isImportSpecifier() ||
              binding.path.isImportDefaultSpecifier() ||
              binding.path.isImportNamespaceSpecifier()) &&
            importNames.includes((local.node as NodeWithName).name || '')
          ) {
            aliveExports.add(local);
            return;
          }

          if ([...aliveExports].some((alive) => alive === local)) {
            // It's possible to export multiple values from a single variable initializer, e.g
            // export const { foo, bar } = baz();
            // We need to treat all of them as used if any of them are used, since otherwise
            // we'll attempt to delete the baz() call
            aliveExports.add(local);
          }
        });

        collected.reexports.forEach((exp) => {
          if (onlyExportsSet.has(exp.exported)) {
            aliveExports.add(exp.local);
          }
        });

        const exportToPath = new Map<string, NodePath>();
        Object.entries(exports).forEach(([exported, local]) => {
          exportToPath.set(exported, local);
        });

        collected.reexports.forEach((exp) => {
          exportToPath.set(exp.exported, exp.local);
        });

        const notFoundExports = [...onlyExportsSet].filter(
          (exp) =>
            exp !== '__esModule' && !aliveExports.has(exportToPath.get(exp)!)
        );
        exportToPath.clear();

        const isAllExportsFound = notFoundExports.length === 0;
        if (!isAllExportsFound && ifUnknownExport !== 'ignore') {
          if (ifUnknownExport === 'error') {
            throw new Error(
              `Unknown export(s) requested: ${onlyExports.join(',')}`
            );
          }

          if (ifUnknownExport === 'reexport-all') {
            // If there are unknown exports, we have keep alive all re-exports.
            if (exports['*'] !== undefined) {
              aliveExports.add(exports['*']);
            }

            collected.reexports.forEach((exp) => {
              if (exp.exported === '*') {
                aliveExports.add(exp.local);
              }
            });
          }

          if (ifUnknownExport === 'skip-shaking') {
            this.imports = imports;
            this.exports = exports;
            this.reexports = collected.reexports;
            this.deadExports = [];

            return;
          }
        }

        const forDeleting = [
          ...Object.values(exports),
          ...collected.reexports.map((i) => i.local),
        ].filter((exp) => !aliveExports.has(exp));

        const forDeletingSet = new Set<NodePath>(forDeleting);
        const queueForDeleting = (path: NodePath): boolean => {
          if (isRemoved(path) || forDeletingSet.has(path)) {
            return false;
          }

          forDeletingSet.add(path);
          forDeleting.push(path);
          return true;
        };

        if (!keepSideEffects && !importedAsSideEffect) {
          // Drop side-effect imports for eval-only builds unless they were explicitly requested.
          // This prevents evaluating unrelated runtime code (e.g. Radix) during __wywPreval eval.
          sideEffectImports.forEach((i) => {
            if (hasImportOverride(i.source)) {
              return;
            }

            queueForDeleting(i.local);
          });
        }

        const deleted = new Set<NodePath>();

        let dereferenced: NodePath<Identifier>[] = [];
        let changed = true;
        while (changed) {
          changed = false;
          // eslint-disable-next-line no-restricted-syntax
          for (const path of forDeleting) {
            if (deleted.has(path)) {
              // eslint-disable-next-line no-continue
              continue;
            }

            const binding = getBindingForExport(path);
            const action = findActionForNode(path);
            const parent = action?.[1];
            const outerReferences = (binding?.referencePaths || []).filter(
              (ref) => {
                if (ref === parent || parent?.isAncestor(ref)) {
                  return false;
                }

                return !forDeleting.some(
                  (candidate) =>
                    candidate !== path &&
                    !isRemoved(candidate) &&
                    (candidate === ref || candidate.isAncestor(ref))
                );
              }
            );
            const bindingName = binding?.identifier.name;
            const removableAssignmentStatements = new Set<NodePath>();
            const removableOuterReferences = outerReferences.filter((ref) => {
              if (!bindingName) return false;
              const statement = getPropertyAssignmentStatement(
                ref,
                bindingName
              );
              if (!statement || isWithinAliveExport(statement, aliveExports)) {
                return false;
              }

              removableAssignmentStatements.add(statement);
              return true;
            });

            const blockingReferences = outerReferences.filter(
              (ref) => !removableOuterReferences.includes(ref)
            );

            if (blockingReferences.length > 0 && path.isIdentifier()) {
              // Temporary deref it in order to simplify further checks.
              dereference(path);
              dereferenced.push(path);
            }

            if (
              !deleted.has(path) &&
              binding &&
              blockingReferences.length > 0 &&
              stripExportKeepDeclaration(path)
            ) {
              deleted.add(path);
              changed = true;
              // eslint-disable-next-line no-continue
              continue;
            }

            if (
              !deleted.has(path) &&
              (!binding || blockingReferences.length === 0)
            ) {
              if (removableAssignmentStatements.size > 0) {
                for (const statement of removableAssignmentStatements) {
                  if (queueForDeleting(statement)) {
                    changed = true;
                  }
                }
              }

              if (action) {
                applyAction(action);
              } else {
                removeWithRelated([path]);
              }

              deleted.add(path);
              changed = true;
            }
          }

          dereferenced.forEach((path) => {
            // If path is still alive, we need to reference it back
            if (!isRemoved(path)) {
              reference(path);
            }
          });

          dereferenced = [];

          // Find and mark for deleting all unreferenced variables
          const unreferenced = Object.values(
            file.scope.getAllBindings()
          ).filter((i) => !i.referenced);

          for (const binding of unreferenced) {
            if (binding.path.isVariableDeclarator()) {
              const id = binding.path.get('id');
              if (!isRemoved(id) && !forDeletingSet.has(id)) {
                // Drop dead variable declarations, e.g. `const foo = make();` when `foo` is no longer referenced.
                for (const violation of binding.constantViolations) {
                  if (queueForDeleting(violation)) {
                    changed = true;
                  }
                }

                if (queueForDeleting(id)) {
                  changed = true;
                }
              }
            }

            // Drop import specifiers whose bindings lost all references during shaking
            // (e.g. when we keep only __wywPreval and the rest of the module is removed).
            if (
              (binding.path.isImportSpecifier() ||
                binding.path.isImportDefaultSpecifier() ||
                binding.path.isImportNamespaceSpecifier()) &&
              !isRemoved(binding.path) &&
              !forDeletingSet.has(binding.path)
            ) {
              if (queueForDeleting(binding.path)) {
                changed = true;
              }
            }
          }
        }
      }

      this.imports = withoutRemoved(imports);
      this.exports = {};
      this.deadExports = [];

      Object.entries(exports).forEach(([exported, local]) => {
        if (isRemoved(local)) {
          this.deadExports.push(exported);
        } else {
          this.exports[exported] = local;
        }
      });

      this.reexports = withoutRemoved(collected.reexports);
    },
    visitor: {},
    post(file: BabelFile) {
      const log = shakerLogger.extend(getFileIdx(file.opts.filename!));

      const dynamicImportWarningsEnabled =
        Boolean(process.env.WYW_WARN_DYNAMIC_IMPORTS) &&
        process.env.WYW_WARN_DYNAMIC_IMPORTS !== '0' &&
        process.env.WYW_WARN_DYNAMIC_IMPORTS !== 'false';

      const filename = file.opts.filename!;

      if (
        dynamicImportWarningsEnabled &&
        !warnedDynamicImportFiles.has(filename)
      ) {
        const dynamicImports = this.imports.filter(
          (imp) => !sideEffectImport(imp) && imp.type === 'dynamic'
        );
        if (dynamicImports.length > 0) {
          warnedDynamicImportFiles.add(filename);
          const sources = Array.from(
            new Set(dynamicImports.map((imp) => imp.source))
          ).sort();
          const overrideKeys = sources
            .map((source) => {
              const strippedSource = stripQueryAndHash(source);
              const isFileImport =
                strippedSource.startsWith('.') ||
                pathLib.isAbsolute(strippedSource);

              if (!isFileImport) {
                return { source, key: source };
              }

              try {
                const resolved = syncResolve(strippedSource, filename, []);
                return {
                  source,
                  key: toImportKey({
                    source: strippedSource,
                    resolved,
                    root,
                  }).key,
                };
              } catch {
                return { source, key: strippedSource };
              }
            })
            .filter((item, index, array) => {
              const firstIndexForKey = array.findIndex(
                (i) => i.key === item.key
              );
              return firstIndexForKey === index;
            });
          const warning = [
            `[wyw-in-js] Dynamic imports reached prepare stage`,
            ``,
            `file: ${filename}`,
            `count: ${sources.length}`,
            `sources:`,
            ...sources.map((source) => `  - ${source}`),
            ``,
            `note: these imports will be resolved/processed even if they are lazy (e.g. React.lazy(() => import(...)))`,
            ``,
            `tip: if the imported module is runtime-only or heavy, mock it during evaluation via importOverrides:`,
            `  importOverrides: {`,
            ...overrideKeys.map(
              ({ key, source }) =>
                `    '${key}': { mock: './path/to/mock' }, // from ${source}`
            ),
            `  }`,
            ``,
            `note: importOverrides affects only build-time evaluation (it does not change your bundler runtime behavior)`,
          ].join('\n');
          // eslint-disable-next-line no-console
          console.warn(warning);
        }
      }

      const processedImports = new Set<string>();
      const imports = new Map<string, string[]>();
      const addImport = ({
        imported,
        source,
      }: {
        imported: string;
        source: string;
      }) => {
        if (processedImports.has(`${source}:${imported}`)) {
          return;
        }

        if (!imports.has(source)) {
          imports.set(source, []);
        }

        if (imported) {
          imports.get(source)!.push(imported);
        }

        processedImports.add(`${source}:${imported}`);
      };

      this.imports.forEach(addImport);
      this.reexports.forEach(addImport);

      log('end', `remaining imports: %O`, imports);

      // eslint-disable-next-line no-param-reassign
      (file.metadata as IMetadata).wywEvaluator = {
        imports,
      };

      invalidateTraversalCache(file.path);
    },
  };
}
