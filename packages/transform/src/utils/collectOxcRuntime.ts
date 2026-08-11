import type { ValueCache } from '@wyw-in-js/processor-utils';
import type { RawSourceMap } from 'source-map';

import { EventEmitter } from './EventEmitter';
import { applyOxcProcessors } from './applyOxcProcessors';
import type { OxcProcessorAnalysisPlan } from './applyOxcProcessors/types';
import { normalizeRuntimeCode } from './collectOxcRuntime/normalizeRuntimeCode';
import { createComposedRuntimeSourceMap } from './collectOxcRuntime/sourceMap';
import type {
  OxcCollectOptions,
  OxcCollectResult,
} from './collectOxcRuntime/types';

export const collectOxcRuntime = (
  code: string,
  filename: string,
  root: string,
  options: OxcCollectOptions,
  values: ValueCache,
  inputSourceMap?: RawSourceMap,
  runtimeProcessorPlan?: OxcProcessorAnalysisPlan
): OxcCollectResult => {
  const { eventEmitter = EventEmitter.dummy, ...processorOptions } = options;
  const result = eventEmitter.perf('transform:collect:applyProcessors', () =>
    applyOxcProcessors(
      code,
      {
        filename,
        root,
      },
      {
        ...processorOptions,
        eventEmitter,
        perfPrefix: 'transform:collect:applyProcessors',
      },
      (processor) => {
        eventEmitter.perf('transform:collect:processorRuntime', () => {
          processor.build(values);
          processor.doRuntimeReplacement();
        });
      },
      true,
      false,
      runtimeProcessorPlan
    )
  );
  const normalizedCode = eventEmitter.perf('transform:collect:normalize', () =>
    normalizeRuntimeCode(result.code, filename)
  );
  const map = eventEmitter.perf('transform:collect:sourceMap', () =>
    createComposedRuntimeSourceMap(
      normalizedCode,
      code,
      filename,
      inputSourceMap
    )
  );

  if (result.processors.length === 0) {
    return {
      code: normalizedCode,
      map,
      metadata: null,
    };
  }

  return {
    code: normalizedCode,
    map,
    metadata: {
      dependencies: [
        ...new Set(
          result.processors.flatMap((processor) => processor.fileDependencies)
        ),
      ],
      processors: result.processors,
      replacements: [],
      rules: {},
    },
  };
};
