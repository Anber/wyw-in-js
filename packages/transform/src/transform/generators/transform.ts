import type { NodePath } from '@babel/core';
import type { File, Program } from '@babel/types';

import type { EvaluatorConfig } from '@wyw-in-js/shared';
import type { MissedBabelCoreTypes } from '../../types';
import { collectExportsAndImports } from '../../utils/collectExportsAndImports';
import type { WYWTransformMetadata } from '../../utils/TransformMetadata';
import { getTransformMetadata } from '../../utils/TransformMetadata';
import { runPreevalStage } from '../preevalStage';
import type { Entrypoint } from '../Entrypoint';
import type {
  ITransformAction,
  Services,
  SyncScenarioForAction,
} from '../types';

const EMPTY_FILE = '=== empty file ===';

type PrepareCodeFn = (
  services: Services,
  item: Entrypoint,
  originalAst: File
) => [
  code: string,
  imports: Map<string, string[]> | null,
  metadata: WYWTransformMetadata | null,
];

const collectImportsMap = (
  babel: Services['babel'],
  filename: string,
  code: string,
  ast: File
): Map<string, string[]> => {
  const { File: BabelFile } = babel as typeof babel & MissedBabelCoreTypes;
  const file = new BabelFile({ filename }, { code, ast });
  const program = file.path.find((p) =>
    p.isProgram()
  ) as NodePath<Program> | null;
  if (!program) {
    return new Map();
  }

  const { imports, reexports } = collectExportsAndImports(program);
  const processedImports = new Set<string>();
  const result = new Map<string, string[]>();
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

    if (!result.has(source)) {
      result.set(source, []);
    }

    if (imported) {
      result.get(source)!.push(imported);
    }

    processedImports.add(`${source}:${imported}`);
  };

  imports.forEach(addImport);
  reexports.forEach(addImport);

  return result;
};

export const prepareCode = (
  services: Services,
  item: Entrypoint,
  originalAst: File
): ReturnType<PrepareCodeFn> => {
  const { log, only, loadedAndParsed } = item;
  if (loadedAndParsed.evaluator === 'ignored') {
    log('is ignored');
    return [loadedAndParsed.code ?? '', null, null];
  }

  const { code, evalConfig, evaluator } = loadedAndParsed;
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

  if (only.length === 1 && only[0] === '__wywPreval' && !transformMetadata) {
    log('[evaluator:end] no metadata');
    const imports = collectImportsMap(
      babel,
      evalConfig.filename ?? item.name,
      preevalStageResult.code!,
      preevalStageResult.ast!
    );
    return [preevalStageResult.code!, imports, null];
  }

  log('[preeval] metadata %O', transformMetadata);
  log('[evaluator:start] using %s', evaluator.name);
  log.extend('source')('%s', preevalStageResult.code!);

  const evaluatorConfig: EvaluatorConfig = {
    onlyExports: only,
    highPriorityPlugins: pluginOptions.highPriorityPlugins,
    features: pluginOptions.features,
    importOverrides: pluginOptions.importOverrides,
    root: options.root,
  };

  const [, transformedCode, imports] = eventEmitter.perf(
    'transform:evaluator',
    () =>
      evaluator(
        evalConfig,
        preevalStageResult.ast!,
        preevalStageResult.code!,
        evaluatorConfig,
        babel
      )
  );

  log('[evaluator:end]');

  return [transformedCode, imports, transformMetadata ?? null];
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
export function transform(this: ITransformAction) {
  return internalTransform.call(this, prepareCode);
}
