/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Program } from 'oxc-parser';

import {
  evaluateOxcStaticExpression,
  evaluateOxcStaticExpressionAt,
  isOxcStaticSerializableValue,
} from '../../../utils/collectOxcTemplateDependencies';
import { isDeclarativePreevalValue } from '../../../processors/declarativeSemantics';
import type { ITransformAction, SyncScenarioFor } from '../../types';
import { getStaticMetadataPreevalResult } from './cache';
import {
  debugStaticResolve,
  getStaticBindings,
  isLocalStaticMetadataFile,
  parseProgram,
} from './environment';
import { findExportTarget } from './exportTargets';
import { collectOpaqueRuntimeImportProof } from './opaqueRuntime';
import {
  mergeStaticObjectAssignAliases,
  objectAssignAliasExpressionsForTarget,
  resolveObjectAssignAliasValues,
  resolveObjectAssignProcessorExpression,
} from './objectAssign';
import { prepareProcessorTarget } from './processorTarget';
import {
  collectProcessorImportLocals,
  isKnownProcessorClassValue,
  isProcessorClassValue,
  isSelectorOnlyProcessorValue,
  processorClassNameRuntimeValue,
  isStaticWYWMetaTreeValue,
  isStaticWYWMetaValue,
  type StaticProcessorInstance,
} from './processorStaticModel';
import { bindStaticResolvedValue } from './staticExpression';
import type { StaticExportResolverContext, StaticExportResult } from './types';

type StaticMetadataPreevalResult = NonNullable<
  ReturnType<typeof getStaticMetadataPreevalResult>
>;

type StaticCandidateResolution = {
  dependencies: Set<string>;
  sideEffectDependencies: Set<string>;
};

const isProcessorArtifactValue = (
  value: unknown,
  processors: StaticProcessorInstance[],
  processorClassNames: ReadonlySet<string>
): boolean => {
  const isStaticMeta = isStaticWYWMetaValue(value);
  const isStaticMetaTree = !isStaticMeta && isStaticWYWMetaTreeValue(value);
  const isSelectorOnly =
    !isStaticMeta &&
    !isStaticMetaTree &&
    isSelectorOnlyProcessorValue(value, processors, new Map());
  const isSideEffectClassValue =
    !isStaticMeta &&
    !isStaticMetaTree &&
    !isSelectorOnly &&
    (isProcessorClassValue(value, processors, new Map()) ||
      isKnownProcessorClassValue(value, processorClassNames));

  return (
    isStaticMeta || isStaticMetaTree || isSelectorOnly || isSideEffectClassValue
  );
};

function* resolvePreevalStaticValueCandidates(
  action: ITransformAction,
  filename: string,
  preevalResult: StaticMetadataPreevalResult,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>,
  resolvers: StaticExportResolverContext
): SyncScenarioFor<StaticCandidateResolution> {
  const dependencies = new Set<string>();
  const sideEffectDependencies = new Set<string>();
  const staticValueCache =
    preevalResult.staticValueCache ?? new Map<string, unknown>();

  for (const candidate of preevalResult.staticValueCandidates ?? []) {
    if (staticValueCache.has(candidate.name)) {
      continue;
    }

    const env = new Map<string, unknown>();
    if (candidate.inlineConstants) {
      for (const [name, value] of Object.entries(candidate.inlineConstants)) {
        env.set(name, value);
      }
    }

    let resolvedAll = true;
    for (const binding of candidate.imports) {
      const resolved = yield* resolvers.resolveImportValue(
        action,
        filename,
        binding,
        stack,
        memo
      );
      if (!resolved) {
        resolvedAll = false;
        break;
      }

      env.set(binding.local, resolved.value);
      resolved.dependencies.forEach((dependency) =>
        dependencies.add(dependency)
      );
      resolved.sideEffectDependencies?.forEach((dependency) =>
        sideEffectDependencies.add(dependency)
      );
    }

    if (!resolvedAll) {
      continue;
    }

    const value = evaluateOxcStaticExpression(
      candidate.source,
      filename,
      env,
      getStaticBindings(action)
    );
    if (isOxcStaticSerializableValue(value)) {
      staticValueCache.set(candidate.name, value);
    }
  }

  return { dependencies, sideEffectDependencies };
}

export function* resolveProcessorStaticExport(
  action: ITransformAction,
  filename: string,
  code: string,
  codeHash: string,
  program: Program,
  exportedName: string,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>,
  resolvers: StaticExportResolverContext
): SyncScenarioFor<StaticExportResult | null> {
  const root = action.services.options.root ?? process.cwd();
  if (!isLocalStaticMetadataFile(filename, root)) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'outside-root',
      status: 'rejected',
    });
    return null;
  }

  if (
    collectProcessorImportLocals(action, program, code, filename).size === 0
  ) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'no-processor-imports',
      status: 'rejected',
    });
    return null;
  }

  const preevalResult = getStaticMetadataPreevalResult(
    action,
    filename,
    code,
    codeHash
  );
  if (!preevalResult) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'metadata-preeval-failed',
      status: 'rejected',
    });
    return null;
  }

  const sourceTarget = findExportTarget(program, exportedName);
  const exportedLocalName =
    sourceTarget?.kind === 'expression' ? sourceTarget.localName : undefined;
  const staticCandidateResolution = yield* resolvePreevalStaticValueCandidates(
    action,
    filename,
    preevalResult,
    stack,
    memo,
    resolvers
  );
  preevalResult.finalizeEvaltimeReplacements?.(preevalResult.staticValueCache);

  if (!preevalResult.metadata) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'metadata-missing',
      status: 'rejected',
    });
    return null;
  }

  const processors = preevalResult.metadata
    .processors as unknown as StaticProcessorInstance[];
  const processorClassNames = new Set(
    processors.map((processor) => processorClassNameRuntimeValue(processor))
  );
  if (
    exportedLocalName &&
    preevalResult.staticValueCache?.has(exportedLocalName)
  ) {
    const cachedValue = preevalResult.staticValueCache.get(exportedLocalName);
    if (
      isDeclarativePreevalValue(cachedValue) ||
      !isProcessorArtifactValue(cachedValue, processors, processorClassNames)
    ) {
      debugStaticResolve(action, {
        exported: exportedName,
        filename,
        phase: 'processor-metadata',
        reason: 'static-value-cache',
        status: 'resolved',
      });

      return {
        dependencies: [filename, ...staticCandidateResolution.dependencies],
        sideEffectDependencies: [
          ...staticCandidateResolution.sideEffectDependencies,
        ],
        value: cachedValue,
      };
    }
  }

  const preevalCode = preevalResult.baseCode;
  const preevalProgram = parseProgram(preevalCode, filename);
  const target = findExportTarget(preevalProgram, exportedName);
  if (!target || target.kind === 'import') {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'processor-target-missing',
      status: 'rejected',
    });
    return null;
  }

  const processorObjectAssignAliases = objectAssignAliasExpressionsForTarget(
    preevalProgram,
    target
  );
  const processorExpression = resolveObjectAssignProcessorExpression(
    preevalProgram,
    target.expression
  );
  const opaqueRuntimeImportProof = yield* collectOpaqueRuntimeImportProof(
    action,
    filename,
    preevalProgram,
    processorExpression
  );
  const preparedTarget = prepareProcessorTarget(
    preevalCode,
    filename,
    preevalProgram,
    target,
    exportedName,
    opaqueRuntimeImportProof.names
  );
  if (!preparedTarget) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'unsupported-processor-expression',
      status: 'rejected',
    });
    return null;
  }

  const env = new Map<string, unknown>();
  const dependencies = new Set<string>([filename]);
  const sideEffectDependencies = new Set<string>();
  opaqueRuntimeImportProof.dependencies.forEach((dependency) =>
    dependencies.add(dependency)
  );

  for (const binding of preparedTarget.dependencies.imports) {
    const resolved = yield* resolvers.resolveImportValue(
      action,
      filename,
      binding,
      stack,
      memo
    );
    if (!resolved) {
      debugStaticResolve(action, {
        exported: exportedName,
        filename,
        imported: binding.imported,
        phase: 'processor-metadata',
        reason: 'resolve-failed',
        source: binding.source,
        status: 'rejected',
      });
      return null;
    }

    if (
      !bindStaticResolvedValue(
        env,
        preparedTarget.expression,
        binding.local,
        resolved,
        {
          wrapNonCallable: true,
        }
      )
    ) {
      debugStaticResolve(action, {
        exported: exportedName,
        filename,
        imported: binding.imported,
        phase: 'processor-metadata',
        reason: 'callable-usage-unsupported',
        source: binding.source,
        status: 'rejected',
      });
      return null;
    }

    resolved.dependencies.forEach((dependency) => dependencies.add(dependency));
    resolved.sideEffectDependencies?.forEach((dependency) =>
      sideEffectDependencies.add(dependency)
    );
  }

  const value =
    preparedTarget.evaluationCode && preparedTarget.evaluationSpan
      ? evaluateOxcStaticExpressionAt(
          preparedTarget.evaluationCode,
          filename,
          preparedTarget.evaluationSpan,
          env,
          getStaticBindings(action)
        )
      : evaluateOxcStaticExpressionAt(
          preevalCode,
          filename,
          {
            end: preparedTarget.expression.end,
            start: preparedTarget.expression.start,
          },
          env,
          getStaticBindings(action)
        );
  if (!isOxcStaticSerializableValue(value)) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'non-serializable',
      status: 'rejected',
    });
    return null;
  }

  let resolvedValue = value;
  if (processorObjectAssignAliases && isStaticWYWMetaValue(value)) {
    const aliasValues = yield* resolveObjectAssignAliasValues(
      action,
      filename,
      preevalCode,
      preevalProgram,
      processorObjectAssignAliases,
      stack,
      memo,
      resolvers
    );
    const mergedValue = aliasValues
      ? mergeStaticObjectAssignAliases(value, aliasValues.values)
      : null;

    if (mergedValue) {
      resolvedValue = mergedValue;
      aliasValues?.dependencies.forEach((dependency) =>
        dependencies.add(dependency)
      );
      aliasValues?.sideEffectDependencies.forEach((dependency) =>
        sideEffectDependencies.add(dependency)
      );
    }
  }

  const isStaticMeta = isStaticWYWMetaValue(resolvedValue);
  const isStaticMetaTree =
    !isStaticMeta && isStaticWYWMetaTreeValue(resolvedValue);
  const isSelectorOnly =
    !isStaticMeta &&
    !isStaticMetaTree &&
    isSelectorOnlyProcessorValue(resolvedValue, processors, new Map());
  const isSideEffectClassValue =
    !isStaticMeta &&
    !isStaticMetaTree &&
    !isSelectorOnly &&
    (isProcessorClassValue(resolvedValue, processors, new Map()) ||
      isKnownProcessorClassValue(resolvedValue, processorClassNames));
  if (
    !isStaticMeta &&
    !isStaticMetaTree &&
    !isSelectorOnly &&
    !isSideEffectClassValue
  ) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'non-empty-css-artifact',
      status: 'rejected',
    });
    return null;
  }

  let resolvedReason: string | undefined;
  if (preparedTarget.opaqueRuntimeBase) {
    resolvedReason = 'opaque-runtime-component';
  } else if (isSideEffectClassValue) {
    resolvedReason = 'non-empty-css-artifact-side-effect';
  }

  debugStaticResolve(action, {
    exported: exportedName,
    filename,
    phase: 'processor-metadata',
    reason: resolvedReason,
    status: 'resolved',
  });

  return {
    dependencies: [...dependencies],
    sideEffectDependencies: isSideEffectClassValue
      ? [filename, ...sideEffectDependencies]
      : [...sideEffectDependencies],
    value: resolvedValue,
  };
}
