/* eslint-disable no-restricted-syntax */

import type { Node, Program } from 'oxc-parser';

import type { ImportOverrides } from '@wyw-in-js/shared';

import { collectOxcExportsAndImportsFromProgram } from '../collectOxcExportsAndImports';
import type {
  collectOxcExportsAndImports,
  OxcCollectedImport,
} from '../collectOxcExportsAndImports';
import { collectOxcPatternIdentifierNames as collectPatternNames } from '../oxc/patterns';
import {
  createCallableProvenanceIndex,
  type CallableProvenanceIndex,
} from './callableProvenanceIndex';
import {
  collectMutations,
  collectNestedMutations,
  collectReferences,
  forEachModuleExecutedNode,
} from './executableIndex';
import {
  finalizeShakenModule,
  hasImportOverride,
  parseShakerModule,
  removeExportKeyword,
  splitExportedVariableDeclaration,
  type Replacement,
} from './moduleRewrites';
import {
  isPattern,
  isProvenNonAbruptPatternEvaluation,
  isReceiverOperationProvenInert as proveReceiverOperationInert,
  type PatternInitializerResolver,
  type ReceiverOperation,
} from './patternEffects';

export type InvocationEffectsCollector = (
  node: Node,
  provenance: CallableProvenanceIndex,
  isReceiverOperationProvenInert: (operation: ReceiverOperation) => boolean,
  resolveReceiverOperationRoots: (binding: string) => ReadonlySet<string>
) => {
  bindings: Set<string>;
  opaqueImportedCall: boolean;
};

type AnyNode = Node & Record<string, unknown>;

type OxcShakerOptions = {
  importOverrides?: ImportOverrides;
  keepSideEffects?: boolean;
  onlyExports: string[];
  root?: string;
};

type StatementInfo = {
  bindings: Set<string>;
  exportNames: Set<string>;
  imports: OxcCollectedImport[];
  mutations: Set<string>;
  node: Node;
  references: Set<string>;
  sideEffectImport: boolean;
};

export type OxcShakerResult = {
  code: string;
  imports: Map<string, string[]>;
};

const declarationBindings = (
  declaration: Node | null | undefined
): string[] => {
  if (!declaration) {
    return [];
  }

  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap((item) =>
      collectPatternNames(item.id)
    );
  }

  if (
    (declaration.type === 'FunctionDeclaration' ||
      declaration.type === 'ClassDeclaration' ||
      declaration.type === 'TSEnumDeclaration') &&
    declaration.id
  ) {
    return [declaration.id.name];
  }

  return [];
};

const moduleExportName = (node: Node): string | null => {
  if (node.type === 'Identifier' || node.type === 'Literal') {
    return String((node as AnyNode).name ?? (node as AnyNode).value);
  }

  return null;
};

const hasPotentiallyAbruptPatternEvaluation = (
  node: Node,
  resolveInitializer: PatternInitializerResolver
): boolean => {
  let potentiallyAbrupt = false;
  forEachModuleExecutedNode(node, (current) => {
    if (potentiallyAbrupt) {
      return;
    }

    if (current.type === 'VariableDeclaration') {
      potentiallyAbrupt = current.declarations.some(
        (declarator) =>
          isPattern(declarator.id) &&
          (!declarator.init ||
            !isProvenNonAbruptPatternEvaluation(
              declarator.id,
              declarator.init,
              resolveInitializer
            ))
      );
      return;
    }

    if (
      current.type === 'AssignmentExpression' &&
      current.operator === '=' &&
      isPattern(current.left)
    ) {
      potentiallyAbrupt = !isProvenNonAbruptPatternEvaluation(
        current.left,
        current.right,
        resolveInitializer
      );
    }
  });
  return potentiallyAbrupt;
};

const buildStatementInfo = (
  program: Program,
  collected: ReturnType<typeof collectOxcExportsAndImports>
): StatementInfo[] => {
  const { exports: collectedExports, imports: collectedImports } = collected;
  const importsByStart = new Map<number, OxcCollectedImport[]>();
  collectedImports.forEach((item) => {
    const bucket = importsByStart.get(item.local.start) ?? [];
    bucket.push(item);
    importsByStart.set(item.local.start, bucket);
  });

  return program.body.map((statement) => {
    const node = statement as Node;
    const exportNames = new Set<string>();
    const bindings = new Set<string>();
    const imports: OxcCollectedImport[] = [];
    const references = collectReferences(node);
    let sideEffectImport = false;

    if (node.type === 'ImportDeclaration') {
      sideEffectImport = node.specifiers.length === 0;
      node.specifiers.forEach((specifier) => {
        bindings.add(specifier.local.name);
        const matched = importsByStart.get(specifier.local.start) ?? [];
        imports.push(...matched);
      });

      if (sideEffectImport) {
        const matched = collectedImports.filter(
          (item) =>
            item.imported === 'side-effect' &&
            item.local.start === node.start &&
            item.local.end === node.end
        );
        imports.push(...matched);
      }
    } else if (node.type === 'ExportNamedDeclaration') {
      declarationBindings(node.declaration).forEach((name) =>
        bindings.add(name)
      );
      if (node.declaration) {
        declarationBindings(node.declaration).forEach((name) =>
          exportNames.add(name)
        );
      }

      node.specifiers.forEach((specifier) => {
        const local = moduleExportName(specifier.local);
        const exported = moduleExportName(specifier.exported);
        if (local && !node.source) references.add(local);
        if (exported) exportNames.add(exported);
      });
    } else if (node.type === 'ExportDefaultDeclaration') {
      exportNames.add('default');
      declarationBindings(node.declaration).forEach((name) =>
        bindings.add(name)
      );
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.exported) {
        const exported = moduleExportName(node.exported);
        if (exported) {
          exportNames.add(exported);
        }
      } else {
        exportNames.add('*');
      }
    } else {
      Object.entries(collectedExports).forEach(([exported, local]) => {
        if (local.start >= node.start && local.end <= node.end) {
          exportNames.add(exported);
        }
      });
      declarationBindings(node).forEach((name) => bindings.add(name));
    }

    return {
      bindings,
      exportNames,
      imports,
      mutations: collectMutations(node),
      node,
      references,
      sideEffectImport,
    };
  });
};

export const createStatementGraphShaker =
  (collectInvocationEffects: InvocationEffectsCollector) =>
  (
    code: string,
    filename: string,
    options: OxcShakerOptions
  ): OxcShakerResult => {
    const parsed = parseShakerModule(code, filename);
    const { program } = parsed;
    const collected = collectOxcExportsAndImportsFromProgram(
      program,
      code,
      parsed.isEsModule
    );
    const statements = buildStatementInfo(program, collected);
    const bindingOwners = new Map<string, StatementInfo>();
    statements.forEach((statement) => {
      statement.bindings.forEach((binding) => {
        if (!bindingOwners.has(binding)) {
          bindingOwners.set(binding, statement);
        }
      });
    });
    const patternInitializers = new Map<
      string,
      {
        declarationKind: string;
        owner: StatementInfo;
        value: Node;
      }
    >();
    program.body.forEach((statement, index) => {
      const declaration =
        statement.type === 'ExportNamedDeclaration' ||
        statement.type === 'ExportDefaultDeclaration'
          ? statement.declaration
          : statement;
      if (declaration?.type !== 'VariableDeclaration') {
        return;
      }

      declaration.declarations.forEach((declarator) => {
        if (declarator.id.type === 'Identifier' && declarator.init) {
          patternInitializers.set(declarator.id.name, {
            declarationKind: declaration.kind,
            owner: statements[index]!,
            value: declarator.init,
          });
        } else if (
          declarator.init &&
          (declarator.id.type === 'ObjectPattern' ||
            declarator.id.type === 'ArrayPattern')
        ) {
          const elements =
            declarator.id.type === 'ObjectPattern'
              ? declarator.id.properties
              : declarator.id.elements;
          elements.forEach((element) => {
            if (
              element?.type === 'RestElement' &&
              element.argument.type === 'Identifier'
            ) {
              patternInitializers.set(element.argument.name, {
                declarationKind: declaration.kind,
                owner: statements[index]!,
                value: declarator.init!,
              });
            }
          });
        }
      });
    });

    const requested = new Set(options.onlyExports);
    const keepAllExports = requested.has('*');
    const liveStatements = new Set<StatementInfo>();
    const liveExportStatements = new Set<StatementInfo>();
    const queue: StatementInfo[] = [];
    const bindingQueue: string[] = [];
    const liveBindings = new Set<string>();
    const effectsByBinding = new Map<string, Set<StatementInfo>>();

    const addEffect = (binding: string, statement: StatementInfo): void => {
      const bucket = effectsByBinding.get(binding) ?? new Set<StatementInfo>();
      bucket.add(statement);
      effectsByBinding.set(binding, bucket);
    };

    statements.forEach((statement) => {
      statement.mutations.forEach((binding) => {
        addEffect(binding, statement);
      });
    });

    const callableProvenance = createCallableProvenanceIndex({
      bindingOwners,
      program,
    });

    // Import binding identity is not knowable at the root module boundary.
    // Therefore a module-executed mutation through any imported alias, or an
    // opaque imported call, can affect every otherwise-live root import.
    const importedEffects = new Set<StatementInfo>();

    const bindingEffectsBefore = (
      binding: string,
      statement: StatementInfo
    ): Set<StatementInfo> => {
      const effects = new Set<StatementInfo>();
      const component =
        callableProvenance.aliasComponents.get(binding) ?? new Set([binding]);
      component.forEach((alias) => {
        statements.forEach((effect) => {
          if (
            effect.node.start < statement.node.start &&
            effect.mutations.has(alias)
          ) {
            effects.add(effect);
          }
        });
        effectsByBinding.get(alias)?.forEach((effect) => {
          if (effect.node.start < statement.node.start) {
            effects.add(effect);
          }
        });
      });
      return effects;
    };

    const resolveStableInitializer = (
      statement: StatementInfo,
      name: string
    ): Node | null | undefined => {
      const initializer = patternInitializers.get(name);
      if (!initializer) {
        return undefined;
      }
      if (
        initializer.declarationKind !== 'const' ||
        initializer.owner.node.start > statement.node.start
      ) {
        return null;
      }
      return bindingEffectsBefore(name, statement).size > 0
        ? null
        : initializer.value;
    };

    const resolveReceiverOperationRoots = (
      binding: string,
      statement: StatementInfo
    ): Set<string> => {
      const roots = new Set<string>();
      const visited = new Set<string>();
      const pending = [binding];

      while (pending.length > 0) {
        const current = pending.pop()!;
        const component =
          callableProvenance.aliasComponents.get(current) ?? new Set([current]);
        component.forEach((alias) => {
          if (visited.has(alias)) {
            return;
          }
          visited.add(alias);
          roots.add(alias);

          const addReferences = (owner: StatementInfo): Set<string> => {
            const references = new Set([
              ...owner.references,
              ...callableProvenance.getExternalStatementReferences(owner),
            ]);
            references.forEach((reference) => {
              roots.add(reference);
              if (bindingOwners.has(reference)) {
                pending.push(reference);
              }
            });
            return references;
          };
          const owner = bindingOwners.get(alias);
          if (owner) {
            addReferences(owner);
          }
          bindingEffectsBefore(alias, statement).forEach((effect) => {
            addReferences(effect).forEach((reference) =>
              addEffect(reference, effect)
            );
          });
          callableProvenance
            .nestedAliasSources(alias)
            .forEach((source) => pending.push(source));
        });
      }

      return roots;
    };

    statements.forEach((statement) => {
      if (
        [...statement.mutations].some(callableProvenance.aliasesImportedRoot)
      ) {
        importedEffects.add(statement);
      }

      collectNestedMutations(statement.node).forEach((binding) => {
        const sources = callableProvenance.nestedAliasSources(binding);
        sources.forEach((source) => addEffect(source, statement));
        if ([...sources].some(callableProvenance.aliasesImportedRoot)) {
          importedEffects.add(statement);
        }
      });

      const invocation = collectInvocationEffects(
        statement.node,
        callableProvenance,
        (operation) =>
          proveReceiverOperationInert(operation, {
            arrayPrototypeStable:
              bindingEffectsBefore('Array', statement).size === 0,
            objectPrototypeStable:
              bindingEffectsBefore('Object', statement).size === 0,
            resolveInitializer: (name) =>
              resolveStableInitializer(statement, name),
          }),
        (binding) => resolveReceiverOperationRoots(binding, statement)
      );
      if (invocation.opaqueImportedCall) {
        importedEffects.add(statement);
      }
      invocation.bindings.forEach((binding) => {
        if (bindingOwners.has(binding)) {
          addEffect(binding, statement);
        }

        const sources = callableProvenance.nestedAliasSources(binding);
        sources.forEach((source) => addEffect(source, statement));

        if (callableProvenance.aliasesImportedRoot(binding)) {
          addEffect(binding, statement);
          importedEffects.add(statement);
        }
        if ([...sources].some(callableProvenance.aliasesImportedRoot)) {
          importedEffects.add(statement);
        }
      });
    });
    callableProvenance.rootImportedBindings.forEach((binding) => {
      importedEffects.forEach((effect) => addEffect(binding, effect));
    });

    callableProvenance.aliasComponents.forEach((component, binding) => {
      if (component.values().next().value !== binding) {
        return;
      }

      const effects = new Set<StatementInfo>();
      component.forEach((alias) => {
        effectsByBinding.get(alias)?.forEach((effect) => effects.add(effect));
      });
      component.forEach((alias) => {
        if (effects.size > 0) {
          effectsByBinding.set(alias, effects);
        }
      });
    });

    const mark = (statement: StatementInfo, exported = false): void => {
      if (!liveStatements.has(statement)) {
        liveStatements.add(statement);
        queue.push(statement);
      }

      if (exported) {
        liveExportStatements.add(statement);
      }
    };

    const markBinding = (binding: string): void => {
      const owner = bindingOwners.get(binding);
      if (!owner || liveBindings.has(binding)) {
        return;
      }

      liveBindings.add(binding);
      bindingQueue.push(binding);
      mark(owner);
    };

    statements
      .filter((statement) =>
        hasPotentiallyAbruptPatternEvaluation(statement.node, (name) => {
          const initializer = patternInitializers.get(name);
          if (!initializer) {
            return undefined;
          }
          if (
            initializer.declarationKind !== 'const' ||
            initializer.owner.node.start > statement.node.start
          ) {
            return null;
          }

          const mutatedBeforeEvaluation = [
            ...(effectsByBinding.get(name) ?? []),
          ].some(
            (effect) =>
              effect.node.start > initializer.owner.node.start &&
              effect.node.start < statement.node.start
          );
          return mutatedBeforeEvaluation ? null : initializer.value;
        })
      )
      .forEach((statement) => mark(statement));

    statements.forEach((statement) => {
      const hasWildcardReexport = statement.exportNames.has('*');
      const selectedExports = [...statement.exportNames].filter(
        (name) =>
          keepAllExports ||
          (name === '*' &&
            requested.size > 0 &&
            !requested.has('side-effect')) ||
          requested.has(name)
      );
      if (
        statement.exportNames.size > 0 &&
        (keepAllExports ||
          (hasWildcardReexport &&
            requested.size > 0 &&
            !requested.has('side-effect')) ||
          selectedExports.length > 0)
      ) {
        mark(statement, true);
        const directBindings = [...statement.bindings].filter((binding) =>
          selectedExports.includes(binding)
        );
        if (
          directBindings.length === 0 &&
          selectedExports.includes('default')
        ) {
          statement.bindings.forEach(markBinding);
        } else {
          directBindings.forEach(markBinding);
        }
      }

      if (
        statement.sideEffectImport &&
        (requested.has('side-effect') ||
          options.keepSideEffects ||
          statement.imports.some((item) =>
            hasImportOverride(item.source, options)
          ))
      ) {
        mark(statement);
      }
    });

    while (queue.length > 0 || bindingQueue.length > 0) {
      if (queue.length > 0) {
        const current = queue.shift()!;
        current.references.forEach(markBinding);
      } else {
        const binding = bindingQueue.shift()!;
        effectsByBinding.get(binding)?.forEach((effect) => {
          mark(effect);
        });
      }
    }

    const replacements: Replacement[] = [];
    statements.forEach((statement) => {
      if (!liveStatements.has(statement)) {
        replacements.push({
          end: statement.node.end,
          start: statement.node.start,
          value: '',
        });
        return;
      }

      if (!liveExportStatements.has(statement)) {
        const replacement = removeExportKeyword(code, statement.node);
        if (replacement) {
          replacements.push(replacement);
        }
        return;
      }

      const splitReplacement = splitExportedVariableDeclaration(
        code,
        statement.node,
        requested
      );
      if (splitReplacement) {
        replacements.push(splitReplacement);
      }
    });

    return finalizeShakenModule(code, filename, replacements, options);
  };
