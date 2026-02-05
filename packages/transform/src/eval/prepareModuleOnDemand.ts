import type { File } from '@babel/types';

import type { EvaluatorConfig } from '@wyw-in-js/shared';

import type { Services } from '../transform/types';
import { Entrypoint } from '../transform/Entrypoint';
import { runPreevalStage } from '../transform/preevalStage';
import { getTransformMetadata } from '../utils/TransformMetadata';

export type PreparedModule = {
  code: string;
  imports: Map<string, string[]> | null;
  only: string[];
};

export function prepareModuleOnDemand(
  services: Services,
  id: string,
  only: string[]
): PreparedModule {
  const entrypoint = Entrypoint.createRoot(services, id, only, undefined);
  const { loadedAndParsed } = entrypoint;

  if (loadedAndParsed.evaluator === 'ignored') {
    return {
      code: loadedAndParsed.code ?? '',
      imports: null,
      only: entrypoint.only,
    };
  }

  const ast = loadedAndParsed.ast as File;
  const { code, evalConfig, evaluator } = loadedAndParsed;
  const { options, babel, eventEmitter } = services;
  const { pluginOptions } = options;

  const preevalStageResult = eventEmitter.perf('transform:preeval', () =>
    runPreevalStage(
      babel,
      evalConfig,
      pluginOptions,
      code,
      ast,
      eventEmitter
    )
  );

  const transformMetadata = getTransformMetadata(preevalStageResult.metadata);

  if (only.length === 1 && only[0] === '__wywPreval' && !transformMetadata) {
    return {
      code: preevalStageResult.code!,
      imports: null,
      only: entrypoint.only,
    };
  }

  const evaluatorConfig: EvaluatorConfig = {
    onlyExports: only,
    highPriorityPlugins: pluginOptions.highPriorityPlugins,
    features: pluginOptions.features,
    importOverrides: pluginOptions.importOverrides,
    root: options.root,
  };

  const [, transformedCode, evaluatorImports] = eventEmitter.perf(
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

  return {
    code: transformedCode,
    imports: evaluatorImports,
    only: entrypoint.only,
  };
}
