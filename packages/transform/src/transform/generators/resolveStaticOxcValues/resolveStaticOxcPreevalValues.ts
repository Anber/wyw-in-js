/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { isAbsolute } from 'path';

import { appendOxcWywPreval } from '../../../utils/oxcPreevalStage';
import { stripQueryAndHash } from '../../../utils/parseRequest';
import type { ITransformAction, SyncScenarioFor } from '../../types';
import {
  resolveCandidateValue,
  resolveOpaqueRuntimeCandidateValue,
} from './candidateResolver';
import {
  debugStaticResolve,
  getEvalStrategy,
  getStaticStrategyFailure,
  parseProgram,
} from './environment';
import {
  collectWYWMetaExtendsHelperNames,
  createSameFileStaticWYWMetaHelperResolver,
} from './processorStaticModel';
import { pruneStaticPreevalCode } from './prune';
import { runtimeCallbackPlaceholder } from './staticExpression';
import type { StaticExportResult } from './types';

export function* resolveStaticOxcPreevalValues(
  this: ITransformAction
): SyncScenarioFor<boolean> {
  const preevalResult = this.entrypoint.getPreevalResult();
  if (!preevalResult) {
    return false;
  }

  const candidates = preevalResult.staticValueCandidates ?? [];
  const evalDependencyNames = new Set(preevalResult.dependencyNames ?? []);
  if (candidates.length === 0 && evalDependencyNames.size === 0) {
    return false;
  }

  const filename =
    this.entrypoint.loadedAndParsed.evaluator === 'ignored'
      ? this.entrypoint.name
      : this.entrypoint.loadedAndParsed.evalConfig.filename ??
        this.entrypoint.name;
  const evalStrategy = getEvalStrategy(this);
  if (evalStrategy === 'execute') {
    return false;
  }
  const staticOnly = evalStrategy === 'static';

  const staticValueCache =
    preevalResult.staticValueCache ?? new Map<string, unknown>();
  const staticDependencies = new Set(preevalResult.staticDependencies ?? []);
  const staticImportLocals = new Set<string>(
    preevalResult.staticImportLocals ?? []
  );
  const sideEffectImportLocals = new Set<string>();
  const staticNullWYWMetaExtendsHelpers = new Set(
    preevalResult.staticNullWYWMetaExtendsHelpers ?? []
  );
  const memo = new Map<string, StaticExportResult | null>();
  const opaqueRuntimeBaseHelpers = collectWYWMetaExtendsHelperNames(
    parseProgram(preevalResult.baseCode ?? preevalResult.code, filename)
  );
  // Names of candidates resolved to runtime callbacks (function values).
  // They keep the file out of evalFile but their helper declarations must
  // not be pruned — the runtime call site relies on them.
  const runtimeOnlyCandidateNames = new Set<string>(
    preevalResult.runtimeOnlyStaticValueNames ?? []
  );
  let changed = false;
  let hasKnownStaticCandidate = false;
  const resolveSameFileStaticWYWMetaHelpers =
    createSameFileStaticWYWMetaHelperResolver(
      preevalResult.baseCode ?? preevalResult.code,
      filename
    );
  const applySameFileStaticWYWMetaHelpers = (): boolean => {
    let appliedAny = false;

    for (;;) {
      let applied = false;
      const values = resolveSameFileStaticWYWMetaHelpers(staticValueCache);
      values.forEach((value, name) => {
        if (
          staticValueCache.has(name) ||
          (!evalDependencyNames.has(name) &&
            !opaqueRuntimeBaseHelpers.has(name))
        ) {
          return;
        }

        staticValueCache.set(name, value);
        debugStaticResolve(this, {
          candidate: name,
          filename,
          phase: 'candidate',
          reason: 'same-file-static-metadata',
          status: 'resolved',
        });
        applied = true;
      });

      if (!applied) {
        break;
      }

      appliedAny = true;
    }

    if (appliedAny) {
      changed = true;
      hasKnownStaticCandidate = true;
    }

    return appliedAny;
  };

  applySameFileStaticWYWMetaHelpers();

  for (const candidate of candidates) {
    applySameFileStaticWYWMetaHelpers();

    const isOpaqueRuntimeBaseHelper = opaqueRuntimeBaseHelpers.has(
      candidate.name
    );
    if (
      !evalDependencyNames.has(candidate.name) &&
      !isOpaqueRuntimeBaseHelper &&
      !staticValueCache.has(candidate.name)
    ) {
      debugStaticResolve(this, {
        candidate: candidate.name,
        filename,
        phase: 'candidate',
        reason: 'not-eval-dependency',
        status: 'skipped',
      });
      continue;
    }

    if (staticValueCache.has(candidate.name)) {
      hasKnownStaticCandidate = true;
      candidate.imports.forEach((item) =>
        staticImportLocals.add(item.importLocal ?? item.local)
      );
      if (
        isOpaqueRuntimeBaseHelper &&
        staticValueCache.get(candidate.name) === null
      ) {
        staticNullWYWMetaExtendsHelpers.add(candidate.name);
      }
      debugStaticResolve(this, {
        candidate: candidate.name,
        filename,
        phase: 'candidate',
        reason: 'already-static',
        status: 'skipped',
      });
      continue;
    }

    let resolved: StaticExportResult | null;
    let resolvedOpaqueRuntimeBase = false;
    if (isOpaqueRuntimeBaseHelper) {
      resolved = yield* resolveOpaqueRuntimeCandidateValue(
        this,
        candidate,
        filename
      );
      resolvedOpaqueRuntimeBase = !!resolved;
      if (!resolved) {
        resolved = yield* resolveCandidateValue(
          this,
          candidate,
          filename,
          memo
        );
      }
    } else {
      resolved = yield* resolveCandidateValue(this, candidate, filename, memo);
    }
    if (!resolved) {
      continue;
    }

    if (resolvedOpaqueRuntimeBase) {
      debugStaticResolve(this, {
        candidate: candidate.name,
        filename,
        phase: 'candidate',
        reason: 'opaque-runtime-component',
        status: 'resolved',
      });
      staticNullWYWMetaExtendsHelpers.add(candidate.name);
    }

    if (resolved.runtimeOnly) {
      // Runtime callback — seed a callable placeholder for collect() but
      // track it separately so the `_exp = () => target` helper survives
      // pruning. The runtime call site relies on that helper declaration.
      runtimeOnlyCandidateNames.add(candidate.name);
      staticValueCache.set(candidate.name, runtimeCallbackPlaceholder);
    } else {
      staticValueCache.set(candidate.name, resolved.value);
    }
    hasKnownStaticCandidate = true;
    candidate.imports.forEach((item) =>
      staticImportLocals.add(item.importLocal ?? item.local)
    );
    resolved.dependencies.forEach((dependency) =>
      staticDependencies.add(dependency)
    );
    resolved.sideEffectImportLocals?.forEach((local) =>
      sideEffectImportLocals.add(local)
    );
    changed = true;
    applySameFileStaticWYWMetaHelpers();
  }

  if (
    !changed &&
    (!hasKnownStaticCandidate || preevalResult.staticValuesApplied)
  ) {
    if (staticOnly && evalDependencyNames.size > 0) {
      throw getStaticStrategyFailure(filename, evalDependencyNames);
    }
    return false;
  }

  const dependencyNames = (preevalResult.dependencyNames ?? []).filter(
    (name) =>
      !staticValueCache.has(name) && !runtimeOnlyCandidateNames.has(name)
  );
  if (staticOnly && dependencyNames.length > 0) {
    throw getStaticStrategyFailure(filename, dependencyNames);
  }
  preevalResult.dependencyNames = dependencyNames;
  preevalResult.staticValueCache = staticValueCache;
  preevalResult.staticDependencies = [...staticDependencies];
  preevalResult.staticNullWYWMetaExtendsHelpers = [
    ...staticNullWYWMetaExtendsHelpers,
  ];
  preevalResult.runtimeOnlyStaticValueNames = [...runtimeOnlyCandidateNames];
  preevalResult.staticValuesApplied = true;
  const originalBaseCode = preevalResult.baseCode ?? preevalResult.code;
  const prunableStaticValueNames = new Set(
    [...staticValueCache.keys()].filter(
      (name) => !runtimeOnlyCandidateNames.has(name)
    )
  );
  const staticExtendsHelperValues = new Map(
    [...staticValueCache].filter(
      ([name]) => !runtimeOnlyCandidateNames.has(name)
    )
  );
  staticNullWYWMetaExtendsHelpers.forEach((name) => {
    if (!staticExtendsHelperValues.has(name)) {
      staticExtendsHelperValues.set(name, null);
    }
  });
  const baseCode = pruneStaticPreevalCode(
    originalBaseCode,
    filename,
    prunableStaticValueNames,
    staticImportLocals,
    staticExtendsHelperValues,
    sideEffectImportLocals
  );
  const evalBaseCode =
    sideEffectImportLocals.size > 0
      ? pruneStaticPreevalCode(
          originalBaseCode,
          filename,
          prunableStaticValueNames,
          staticImportLocals,
          staticExtendsHelperValues,
          new Set()
        )
      : baseCode;
  preevalResult.baseCode = baseCode;
  preevalResult.code = appendOxcWywPreval(baseCode, filename, dependencyNames);
  preevalResult.evalCode = appendOxcWywPreval(
    evalBaseCode,
    filename,
    dependencyNames
  );
  preevalResult.staticImportLocals = [...staticImportLocals];
  preevalResult.staticSideEffectImportLocals = [...sideEffectImportLocals];

  for (const dependency of staticDependencies) {
    const strippedDependency = stripQueryAndHash(dependency);
    if (isAbsolute(strippedDependency)) {
      this.services.cache.checkFreshness(dependency, strippedDependency);
    }

    this.entrypoint.addInvalidationDependency({
      only: ['*'],
      resolved: dependency,
      source: dependency,
    });
    this.entrypoint.markInvalidateOnDependencyChange(dependency);
  }

  return true;
}
