/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Expression } from 'oxc-parser';

import {
  evaluateOxcStaticExpression,
  isOxcStaticSerializableValue,
  lookupStaticBinding,
  type OxcStaticValueCandidate,
} from '../../../utils/collectOxcTemplateDependencies';
import type { ITransformAction, SyncScenarioFor } from '../../types';
import { resolveDependency } from './dependencies';
import {
  debugStaticResolve,
  getStaticBindings,
  type StaticRejectionReason,
} from './environment';
import { resolveImportValue } from './exportResolver';
import { resolveImportAsOpaqueRuntime } from './opaqueRuntime';
import {
  bindStaticResolvedValue,
  isRuntimeCallbackExpression,
  parseStaticExpressionSource,
} from './staticExpression';
import type { OpaqueRuntimeImportProof, StaticExportResult } from './types';

export function* resolveCandidateValue(
  action: ITransformAction,
  candidate: OxcStaticValueCandidate,
  filename: string,
  memo: Map<string, StaticExportResult | null>,
  reasons?: Map<string, StaticRejectionReason>
): SyncScenarioFor<StaticExportResult | null> {
  const reject = (reason: StaticRejectionReason): null => {
    reasons?.set(candidate.name, reason);
    return null;
  };
  const env = new Map<string, unknown>();
  const dependencies = new Set<string>();
  const sideEffectDependencies = new Set<string>();
  const sideEffectImportLocals = new Set<string>();
  let candidateExpression: Expression | null | undefined;

  if (candidate.inlineConstants) {
    for (const [name, value] of Object.entries(candidate.inlineConstants)) {
      env.set(name, value);
    }
  }

  const staticBindingsForCandidate = getStaticBindings(action);

  for (const item of candidate.imports) {
    // staticBindings overrides take precedence over actual import
    // resolution: a registered value (or function) replaces whatever
    // the source module would otherwise provide. Useful for prototyping
    // / SSR theming and for opaque utilities like `cx`.
    //
    // Match the override map first by the raw specifier as written
    // (`@linaria/core`, `./flags`, …). If that misses, resolve to an
    // absolute path and try again — this lets the host key by
    // absolute file path so a single entry covers every relative
    // variant of the same module.
    let override = lookupStaticBinding(
      staticBindingsForCandidate,
      item.source,
      item.imported
    );
    if (!override.found && staticBindingsForCandidate) {
      const dep = yield* resolveDependency(
        action,
        filename,
        item.source,
        item.imported
      );
      if (dep?.resolved) {
        override = lookupStaticBinding(
          staticBindingsForCandidate,
          dep.resolved,
          item.imported
        );
      }
    }
    if (override.found) {
      env.set(item.local, override.value);
      continue;
    }

    const resolved = yield* resolveImportValue(
      action,
      filename,
      item,
      new Set(),
      memo
    );
    if (!resolved) {
      debugStaticResolve(action, {
        candidate: candidate.name,
        filename,
        imported: item.imported,
        phase: 'candidate',
        reason: 'candidate-import-unresolved',
        source: item.source,
        status: 'rejected',
      });
      return reject('candidate-import-unresolved');
    }

    if (resolved.callable === 'zero-arg' && candidateExpression === undefined) {
      candidateExpression = parseStaticExpressionSource(
        candidate.source,
        filename
      );
    }

    const expressionForBinding =
      resolved.callable === 'zero-arg' ? candidateExpression : null;
    if (
      (resolved.callable === 'zero-arg' && !expressionForBinding) ||
      (expressionForBinding &&
        !bindStaticResolvedValue(
          env,
          expressionForBinding,
          item.local,
          resolved
        ))
    ) {
      debugStaticResolve(action, {
        candidate: candidate.name,
        filename,
        imported: item.imported,
        phase: 'candidate',
        reason: 'candidate-callable-usage-unsupported',
        source: item.source,
        status: 'rejected',
      });
      return reject('candidate-callable-usage-unsupported');
    }

    if (!expressionForBinding) {
      env.set(item.local, resolved.value);
    }

    resolved.dependencies.forEach((dependency) => dependencies.add(dependency));
    resolved.sideEffectDependencies?.forEach((dependency) => {
      sideEffectDependencies.add(dependency);
      sideEffectImportLocals.add(item.importLocal ?? item.local);
    });
  }

  if (candidateExpression === undefined) {
    candidateExpression = parseStaticExpressionSource(
      candidate.source,
      filename
    );
  }

  const value = evaluateOxcStaticExpression(
    candidate.source,
    filename,
    env,
    getStaticBindings(action)
  );
  // Function-valued candidates are runtime callbacks (e.g. styled-
  // component dynamic prop interpolations like `${props => ...}`). The
  // value isn't serializable, but the candidate IS resolved — the
  // local `_exp = () => target` arrow already lives in the bundle, so
  // the file does not need evalFile to compute it. Mark the result as
  // runtimeOnly so the helper declaration survives pruning.
  if (
    typeof value === 'function' ||
    (value === undefined && isRuntimeCallbackExpression(candidateExpression))
  ) {
    debugStaticResolve(action, {
      candidate: candidate.name,
      filename,
      phase: 'candidate',
      reason: 'runtime-callback',
      status: 'resolved',
    });
    return {
      dependencies: [...dependencies],
      runtimeOnly: true,
      sideEffectDependencies: [...sideEffectDependencies],
      sideEffectImportLocals: [...sideEffectImportLocals],
      value,
    };
  }

  if (!isOxcStaticSerializableValue(value)) {
    // A bare `undefined` here means the import resolved but the export is
    // missing/empty (e.g. an emptied module) — distinct from a value that is
    // genuinely non-serializable (functions are already handled above).
    const reason =
      value === undefined
        ? 'candidate-expression-undefined'
        : 'candidate-expression-non-serializable';
    debugStaticResolve(action, {
      candidate: candidate.name,
      filename,
      phase: 'candidate',
      reason,
      status: 'rejected',
    });
    return reject(reason);
  }

  debugStaticResolve(action, {
    candidate: candidate.name,
    filename,
    phase: 'candidate',
    status: 'resolved',
  });

  return {
    dependencies: [...dependencies],
    sideEffectDependencies: [...sideEffectDependencies],
    sideEffectImportLocals: [...sideEffectImportLocals],
    value,
  };
}

export function* resolveOpaqueRuntimeCandidateValue(
  action: ITransformAction,
  candidate: OxcStaticValueCandidate,
  filename: string
): SyncScenarioFor<StaticExportResult | null> {
  if (candidate.imports.length === 0) {
    return null;
  }

  const dependencies = new Set<string>();
  const memo = new Map<string, OpaqueRuntimeImportProof | null>();

  for (const item of candidate.imports) {
    const proof = yield* resolveImportAsOpaqueRuntime(
      action,
      filename,
      item,
      new Set(),
      memo
    );
    if (!proof) {
      return null;
    }

    proof.dependencies.forEach((dependency) => dependencies.add(dependency));
  }

  return {
    dependencies: [...dependencies],
    value: null,
  };
}
