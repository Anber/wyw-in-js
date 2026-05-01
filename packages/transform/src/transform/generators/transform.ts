import { oxcShaker } from '../../shaker';
import type { WYWTransformMetadata } from '../../utils/TransformMetadata';
import { collectOxcExportsAndImports } from '../../utils/collectOxcExportsAndImports';
import { emitOxcCommonJS, stripTypesAndJsxWithOxc } from '../../utils/oxcEmit';
import { runOxcPreevalStage } from '../../utils/oxcPreevalStage';
import {
  removeUnusedEagerTopLevelDeclarations,
  shakeOxcToESM,
} from '../../utils/oxcShaker';
import type { Entrypoint } from '../Entrypoint';
import type {
  IEntrypointDependency,
  IPreevalResult,
} from '../Entrypoint.types';
import type {
  ITransformAction,
  Services,
  SyncScenarioForAction,
} from '../types';

import { rewriteOptimizedOxcBarrelImports } from './rewriteOxcBarrelImports';
import { resolveStaticOxcPreevalValues } from './resolveStaticOxcValues';

const EMPTY_FILE = '=== empty file ===';

const collectImportsFromOxc = (
  code: string,
  filename: string
): Map<string, string[]> => {
  const imports = new Map<string, string[]>();
  const addImport = (source: string, imported: string) => {
    const bucket = imports.get(source) ?? [];
    if (!bucket.includes(imported)) {
      bucket.push(imported);
    }

    imports.set(source, bucket);
  };

  collectOxcExportsAndImports(code, filename).imports.forEach((item) => {
    addImport(item.source, item.imported || 'side-effect');
  });

  return imports;
};

type PrepareCodeFn = (
  services: Services,
  item: Entrypoint,
  originalAst: unknown | null
) => [
  code: string,
  imports: Map<string, string[]> | null,
  metadata: WYWTransformMetadata | null,
];

const isPrevalOnly = (only: string[]) =>
  only.length === 1 && only[0] === '__wywPreval';

type PrepareCodeOptions = {
  emitCommonJS?: boolean;
  shortCircuitOnMissingMetadata?: boolean;
  stripForEvalRuntime?: boolean;
};

const normalizeOxcPreparedESM = (code: string): string =>
  code
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/[ \t\n]+$/, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/^const /gm, 'var ');

const ensureOxcPreevalResult = (
  services: Services,
  item: Entrypoint,
  originalAst: unknown | null
): IPreevalResult => {
  const cached = item.getPreevalResult();
  if (cached) {
    return cached;
  }

  const { loadedAndParsed } = item;
  if (loadedAndParsed.evaluator === 'ignored') {
    throw new Error('Cannot run Oxc preeval for an ignored entrypoint.');
  }

  const filename = loadedAndParsed.evalConfig.filename ?? item.name;
  const { eventEmitter } = services;
  const { pluginOptions } = services.options;
  const root = services.options.root ?? process.cwd();

  const preevalStageResult = eventEmitter.perf('transform:preeval', () => {
    const result = runOxcPreevalStage(
      loadedAndParsed.code,
      {
        filename,
        root,
      },
      {
        ...pluginOptions,
        eventEmitter,
      }
    );

    return {
      ast: originalAst,
      baseCode: result.baseCode,
      code: result.code,
      dependencyNames: result.dependencyNames,
      evalCode: result.code,
      metadata: result.metadata,
      staticSideEffectImportLocals: [],
      staticDependencies: result.staticDependencies,
      staticValueCache: result.staticValueCache,
      staticValueCandidates: result.staticValueCandidates,
    };
  });

  item.setPreevalResult(preevalStageResult);
  return preevalStageResult;
};

const prepareOxcCodeImpl = (
  services: Services,
  item: Entrypoint,
  originalAst: unknown | null,
  options: PrepareCodeOptions = {}
): ReturnType<PrepareCodeFn> => {
  const { only, loadedAndParsed, log } = item;
  if (loadedAndParsed.evaluator === 'ignored') {
    log('is ignored');
    return [loadedAndParsed.code ?? '', null, null];
  }

  const filename = loadedAndParsed.evalConfig.filename ?? item.name;
  const { eventEmitter } = services;
  const { pluginOptions } = services.options;
  const root = services.options.root ?? process.cwd();

  const preevalStageResult = ensureOxcPreevalResult(
    services,
    item,
    originalAst
  );

  const transformMetadata = preevalStageResult.metadata;
  const preevalCode =
    options.stripForEvalRuntime && preevalStageResult.evalCode
      ? preevalStageResult.evalCode
      : preevalStageResult.code;
  if (
    isPrevalOnly(only) &&
    !transformMetadata &&
    options.shortCircuitOnMissingMetadata !== false
  ) {
    log('[evaluator:end] no metadata');
    const strippedCode = removeUnusedEagerTopLevelDeclarations(
      stripTypesAndJsxWithOxc(preevalCode, filename).code,
      filename
    );

    return [
      normalizeOxcPreparedESM(strippedCode),
      collectImportsFromOxc(strippedCode, filename),
      null,
    ];
  }

  log('[preeval] metadata %O', transformMetadata);
  log('[evaluator:start] using %s', loadedAndParsed.evaluator.name);
  log.extend('source')('%s', preevalCode);

  const shaken = eventEmitter.perf('transform:evaluator', () =>
    shakeOxcToESM(preevalCode, filename, {
      importOverrides: pluginOptions.importOverrides,
      onlyExports: only,
      root,
    })
  );

  log('[evaluator:end]');

  if (!options.emitCommonJS) {
    const preparedCode = options.stripForEvalRuntime
      ? stripTypesAndJsxWithOxc(shaken.code, filename).code
      : shaken.code;

    return [
      normalizeOxcPreparedESM(preparedCode),
      options.stripForEvalRuntime
        ? collectImportsFromOxc(preparedCode, filename)
        : shaken.imports,
      transformMetadata ?? null,
    ];
  }

  const emitted = eventEmitter.perf('transform:emitCommonJS', () =>
    emitOxcCommonJS(shaken.code, filename)
  );

  return [emitted.code, shaken.imports, transformMetadata ?? null];
};

const prepareCodeImpl = (
  services: Services,
  item: Entrypoint,
  originalAst: unknown | null,
  options: PrepareCodeOptions = {}
): ReturnType<PrepareCodeFn> => {
  const { log, loadedAndParsed } = item;
  if (loadedAndParsed.evaluator === 'ignored') {
    log('is ignored');
    return [loadedAndParsed.code ?? '', null, null];
  }

  const { evaluator } = loadedAndParsed;
  if (evaluator !== oxcShaker) {
    throw new Error(
      `[wyw-in-js] ${item.name} matched a legacy evaluator. The Oxc runtime path supports only the default Oxc evaluator.`
    );
  }

  return prepareOxcCodeImpl(services, item, originalAst, options);
};

export const prepareCode = (
  services: Services,
  item: Entrypoint,
  originalAst: unknown | null
): ReturnType<PrepareCodeFn> => prepareCodeImpl(services, item, originalAst);

export const prepareCodeForEvalRuntime = (
  services: Services,
  item: Entrypoint,
  originalAst: unknown | null
): ReturnType<PrepareCodeFn> =>
  prepareCodeImpl(services, item, originalAst, {
    shortCircuitOnMissingMetadata: true,
    stripForEvalRuntime: true,
  });

export function* internalTransform(
  this: ITransformAction,
  prepareFn: PrepareCodeFn
): SyncScenarioForAction<ITransformAction> {
  const { only, loadedAndParsed, log } = this.entrypoint;
  if (loadedAndParsed.evaluator === 'ignored') {
    log('is ignored');
    return {
      code: loadedAndParsed.code ?? '',
      metadata: null,
    };
  }

  if (loadedAndParsed.evaluator !== oxcShaker) {
    throw new Error(
      `[wyw-in-js] ${this.entrypoint.name} matched a legacy evaluator. The Oxc runtime path supports only the default Oxc evaluator.`
    );
  }

  log('>> (%o)', only);

  if (loadedAndParsed.evaluator === oxcShaker) {
    ensureOxcPreevalResult(this.services, this.entrypoint, null);
    yield* resolveStaticOxcPreevalValues.call(this);
  }

  const [preparedCode, imports, metadata] = prepareFn(
    this.services,
    this.entrypoint,
    null
  );
  let finalPreparedCode = preparedCode;

  if (loadedAndParsed.evaluator === oxcShaker) {
    if (metadata === null && isPrevalOnly(only)) {
      log(
        'skip resolving imports for __wywPreval-only entrypoint without metadata'
      );
      return {
        code: finalPreparedCode,
        metadata: null,
      };
    }

    let nextCode = preparedCode;
    let nextResolvedImports: IEntrypointDependency[] = [];
    let skippedParentDependencyTracking: string[] = [];

    if (imports !== null && imports.size > 0) {
      const resolvedImports = yield* this.getNext(
        'resolveImports',
        this.entrypoint,
        {
          imports,
          phase: 'initial',
        }
      );

      if (resolvedImports.length > 0) {
        const rewritten = yield* rewriteOptimizedOxcBarrelImports.call(
          this,
          preparedCode,
          loadedAndParsed.evalConfig.filename ?? this.entrypoint.name,
          resolvedImports
        );

        nextCode = rewritten.code;

        if (rewritten.optimizedCount > 0) {
          skippedParentDependencyTracking = rewritten.generatedSources;
          const fullyRewrittenSources = new Set(
            rewritten.fullyRewrittenSources
          );
          const partialFallbackSources = new Set(
            rewritten.partialFallbackSources
          );

          for (const dependency of resolvedImports) {
            if (
              dependency.resolved &&
              (fullyRewrittenSources.has(dependency.source) ||
                partialFallbackSources.has(dependency.source))
            ) {
              if (partialFallbackSources.has(dependency.source)) {
                this.entrypoint.addDependency(dependency);
              } else {
                this.entrypoint.addInvalidationDependency(dependency);
              }

              this.entrypoint.markInvalidateOnDependencyChange(
                dependency.resolved
              );
            }
          }

          nextResolvedImports = yield* this.getNext(
            'resolveImports',
            this.entrypoint,
            {
              imports: rewritten.imports,
              phase: 'rewritten',
              preResolved: rewritten.preResolvedImports,
            }
          );
        } else {
          nextResolvedImports = resolvedImports;
        }
      }
    }

    if (nextResolvedImports.length !== 0) {
      yield [
        'processImports',
        this.entrypoint,
        {
          resolved: nextResolvedImports,
          skipParentDependencyTracking: skippedParentDependencyTracking,
        },
      ];
    }

    finalPreparedCode = this.services.eventEmitter.perf(
      'transform:emitCommonJS',
      () =>
        emitOxcCommonJS(
          nextCode,
          loadedAndParsed.evalConfig.filename ?? this.entrypoint.name
        ).code
    );
  }

  if (loadedAndParsed.code === finalPreparedCode) {
    log('<< (%o)\n === no changes ===', only);
  } else {
    log('<< (%o)', only);
    log.extend('source')('%s', finalPreparedCode || EMPTY_FILE);
  }

  if (finalPreparedCode === '') {
    log('is skipped');
    return {
      code: loadedAndParsed.code ?? '',
      metadata,
    };
  }

  if (metadata === null && isPrevalOnly(only)) {
    log(
      'skip resolving imports for __wywPreval-only entrypoint without metadata'
    );
    return {
      code: finalPreparedCode,
      metadata: null,
    };
  }

  if (
    loadedAndParsed.evaluator !== oxcShaker &&
    imports !== null &&
    imports.size > 0
  ) {
    const resolvedImports = yield* this.getNext(
      'resolveImports',
      this.entrypoint,
      {
        imports,
      }
    );

    if (resolvedImports.length !== 0) {
      yield [
        'processImports',
        this.entrypoint,
        {
          resolved: resolvedImports,
        },
      ];
    }
  }

  return {
    code: finalPreparedCode,
    metadata,
  };
}

export function* transform(
  this: ITransformAction
): SyncScenarioForAction<ITransformAction> {
  return yield* internalTransform.call(this, prepareCode);
}
