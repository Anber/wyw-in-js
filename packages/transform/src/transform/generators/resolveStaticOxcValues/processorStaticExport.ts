/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Program } from 'oxc-parser';

import {
  evaluateOxcStaticExpressionAt,
  isOxcStaticSerializableValue,
} from '../../../utils/collectOxcTemplateDependencies';
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
  const processors = preevalResult.metadata
    .processors as unknown as StaticProcessorInstance[];
  const processorClassNames = new Set(
    processors.map((processor) => processorClassNameRuntimeValue(processor))
  );
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
