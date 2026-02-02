import type {
  BabelFileResult,
  PluginItem,
  TransformOptions,
} from '@babel/core';
import type { File } from '@babel/types';

import type { EvaluatorConfig, StrictOptions } from '@wyw-in-js/shared';

import type { Core } from '../../babel';
import { buildOptions } from '../../options/buildOptions';
import dynamicImportPlugin from '../../plugins/dynamic-import';
import preevalPlugin from '../../plugins/preeval';
import { emitCommonJS, shakeToESM, shaker } from '../../shaker';
import type { EventEmitter } from '../../utils/EventEmitter';
import type { WYWTransformMetadata } from '../../utils/TransformMetadata';
import { getTransformMetadata } from '../../utils/TransformMetadata';
import { getPluginKey } from '../../utils/getPluginKey';
import type { Entrypoint } from '../Entrypoint';
import type { IEntrypointDependency } from '../Entrypoint.types';
import type {
  ITransformAction,
  Services,
  SyncScenarioForAction,
} from '../types';
import { rewriteOptimizedBarrelImports } from './rewriteBarrelImports';

const EMPTY_FILE = '=== empty file ===';

const hasKeyInList = (plugin: PluginItem, list: string[]): boolean => {
  const pluginKey = getPluginKey(plugin);
  return pluginKey ? list.some((i) => pluginKey.includes(i)) : false;
};

function runPreevalStage(
  babel: Core,
  evalConfig: TransformOptions,
  pluginOptions: StrictOptions,
  code: string,
  originalAst: File,
  eventEmitter: EventEmitter
): BabelFileResult {
  const preShakePlugins =
    evalConfig.plugins?.filter((i) =>
      hasKeyInList(i, pluginOptions.highPriorityPlugins)
    ) ?? [];

  const plugins = [
    ...preShakePlugins,
    [
      preevalPlugin,
      {
        ...pluginOptions,
        eventEmitter,
      },
    ],
    dynamicImportPlugin,
    ...(evalConfig.plugins ?? []).filter(
      (i) => !hasKeyInList(i, pluginOptions.highPriorityPlugins)
    ),
  ];

  const transformConfig = buildOptions({
    ...evalConfig,
    envName: 'wyw-in-js',
    plugins,
  });

  const result = babel.transformFromAstSync(originalAst, code, transformConfig);

  if (!result || !result.ast?.program) {
    throw new Error('Babel transform failed');
  }

  return result;
}

type PrepareCodeFn = (
  services: Services,
  item: Entrypoint,
  originalAst: File
) => [
  code: string,
  imports: Map<string, string[]> | null,
  metadata: WYWTransformMetadata | null,
];

type PreparedEvaluatorInput =
  | {
      kind: 'continue';
      ast: File;
      code: string;
      evalConfig: TransformOptions;
      evaluatorConfig: EvaluatorConfig;
      metadata: WYWTransformMetadata | null;
    }
  | {
      kind: 'short-circuit';
      code: string;
    };

const isPrevalOnly = (only: string[]) =>
  only.length === 1 && only[0] === '__wywPreval';

const prepareEvaluatorInput = (
  services: Services,
  item: Entrypoint,
  originalAst: File
): PreparedEvaluatorInput => {
  const { only, loadedAndParsed, log } = item;
  if (loadedAndParsed.evaluator === 'ignored') {
    throw new Error(`Cannot prepare ignored entrypoint ${item.name}`);
  }

  const { code, evalConfig } = loadedAndParsed;
  const { options, babel, eventEmitter } = services;
  const { pluginOptions } = options;

  const preevalStageResult = eventEmitter.perf('transform:preeval', () =>
    runPreevalStage(
      babel,
      evalConfig,
      pluginOptions,
      code,
      originalAst,
      eventEmitter
    )
  );

  const transformMetadata = getTransformMetadata(preevalStageResult.metadata);
  if (isPrevalOnly(only) && !transformMetadata) {
    log('[evaluator:end] no metadata');
    return {
      kind: 'short-circuit',
      code: preevalStageResult.code!,
    };
  }

  log('[preeval] metadata %O', transformMetadata);

  return {
    kind: 'continue',
    ast: preevalStageResult.ast!,
    code: preevalStageResult.code!,
    evalConfig,
    evaluatorConfig: {
      onlyExports: only,
      highPriorityPlugins: pluginOptions.highPriorityPlugins,
      features: pluginOptions.features,
      importOverrides: pluginOptions.importOverrides,
      root: options.root,
    },
    metadata: transformMetadata ?? null,
  };
};

export const prepareCode = (
  services: Services,
  item: Entrypoint,
  originalAst: File
): ReturnType<PrepareCodeFn> => {
  const { log, loadedAndParsed } = item;
  if (loadedAndParsed.evaluator === 'ignored') {
    log('is ignored');
    return [loadedAndParsed.code ?? '', null, null];
  }

  const { evaluator } = loadedAndParsed;
  const { babel, eventEmitter } = services;
  const prepared = prepareEvaluatorInput(services, item, originalAst);
  if (prepared.kind === 'short-circuit') {
    return [prepared.code, null, null];
  }

  log('[evaluator:start] using %s', evaluator.name);
  log.extend('source')('%s', prepared.code);

  const [, transformedCode, imports] = eventEmitter.perf(
    'transform:evaluator',
    () =>
      evaluator(
        prepared.evalConfig,
        prepared.ast,
        prepared.code,
        prepared.evaluatorConfig,
        babel
      )
  );

  log('[evaluator:end]');

  return [transformedCode, imports, prepared.metadata];
};

// eslint-disable-next-line require-yield
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

  log('>> (%o)', only);

  const [preparedCode, , metadata] = prepareFn(
    this.services,
    this.entrypoint,
    loadedAndParsed.ast
  );

  if (loadedAndParsed.code === preparedCode) {
    log('<< (%o)\n === no changes ===', only);
  } else {
    log('<< (%o)', only);
    log.extend('source')('%s', preparedCode || EMPTY_FILE);
  }

  if (preparedCode === '') {
    log('is skipped');
    return {
      code: loadedAndParsed.code ?? '',
      metadata: null,
    };
  }

  return {
    code: preparedCode,
    metadata,
  };
}

/**
 * Prepares the code for evaluation. This includes removing dead and potentially unsafe code.
 */
export function* transform(
  this: ITransformAction
): SyncScenarioForAction<ITransformAction> {
  const { only, loadedAndParsed, log } = this.entrypoint;
  if (loadedAndParsed.evaluator === 'ignored') {
    log('is ignored');
    return {
      code: loadedAndParsed.code ?? '',
      metadata: null,
    };
  }

  if (loadedAndParsed.evaluator !== shaker) {
    return yield* internalTransform.call(this, prepareCode);
  }

  log('>> (%o)', only);

  const prepared = prepareEvaluatorInput(
    this.services,
    this.entrypoint,
    loadedAndParsed.ast
  );

  if (prepared.kind === 'short-circuit') {
    if (loadedAndParsed.code === prepared.code) {
      log('<< (%o)\n === no changes ===', only);
    } else {
      log('<< (%o)', only);
      log.extend('source')('%s', prepared.code || EMPTY_FILE);
    }

    if (prepared.code === '') {
      log('is skipped');
      return {
        code: loadedAndParsed.code ?? '',
        metadata: null,
      };
    }

    return {
      code: prepared.code,
      metadata: null,
    };
  }

  log('[evaluator:start] using %s', loadedAndParsed.evaluator.name);
  log.extend('source')('%s', prepared.code);

  const { babel, eventEmitter } = this.services;
  const [shakenAst, shakenCode, shakenImports] = eventEmitter.perf(
    'transform:evaluator',
    () =>
      shakeToESM(
        prepared.evalConfig,
        prepared.ast,
        prepared.code,
        prepared.evaluatorConfig,
        babel
      )
  );

  let nextAst = shakenAst;
  let nextCode = shakenCode;
  let nextResolvedImports: IEntrypointDependency[] = [];

  if (shakenImports !== null && shakenImports.size > 0) {
    const resolvedImports = yield* this.getNext(
      'resolveImports',
      this.entrypoint,
      {
        imports: shakenImports,
        phase: 'initial',
      }
    );

    if (resolvedImports.length > 0) {
      const rewritten = yield* rewriteOptimizedBarrelImports.call(
        this,
        shakenAst,
        shakenCode,
        resolvedImports
      );

      nextAst = rewritten.ast;
      nextCode = rewritten.code;
      if (rewritten.optimizedCount > 0) {
        const fullyRewrittenSources = new Set(rewritten.fullyRewrittenSources);
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
      },
    ];
  }

  const [, preparedCode] = eventEmitter.perf('transform:emitCommonJS', () =>
    emitCommonJS(prepared.evalConfig, nextAst, nextCode, babel)
  );

  log('[evaluator:end]');

  if (loadedAndParsed.code === preparedCode) {
    log('<< (%o)\n === no changes ===', only);
  } else {
    log('<< (%o)', only);
    log.extend('source')('%s', preparedCode || EMPTY_FILE);
  }

  if (preparedCode === '') {
    log('is skipped');
    return {
      code: loadedAndParsed.code ?? '',
      metadata: null,
    };
  }

  return {
    code: preparedCode,
    metadata: prepared.metadata,
  };
}
