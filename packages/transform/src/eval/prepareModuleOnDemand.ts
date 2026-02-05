import type { File } from '@babel/types';

import type { EvaluatorConfig } from '@wyw-in-js/shared';

import type { Services } from '../transform/types';
import { Entrypoint } from '../transform/Entrypoint';
import { runPreevalStage } from '../transform/preevalStage';
import { collectExportsAndImports } from '../utils/collectExportsAndImports';
import { getTransformMetadata } from '../utils/TransformMetadata';

export type PreparedModule = {
  code: string;
  imports: Map<string, string[]> | null;
  only: string[];
};

const collectImportsMap = (
  services: Services,
  ast: File
): Map<string, string[]> => {
  const imports = new Map<string, string[]>();
  const processedImports = new Set<string>();

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

  services.babel.traverse(ast, {
    Program(path) {
      const collected = collectExportsAndImports(path);
      collected.imports.forEach(addImport);
      collected.reexports.forEach(addImport);
    },
  });

  return imports;
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
  const imports = collectImportsMap(services, preevalStageResult.ast!);

  if (only.length === 1 && only[0] === '__wywPreval' && !transformMetadata) {
    return {
      code: preevalStageResult.code!,
      imports,
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
    imports: evaluatorImports ?? imports,
    only: entrypoint.only,
  };
}
