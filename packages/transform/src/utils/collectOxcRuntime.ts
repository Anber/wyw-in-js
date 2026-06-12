import type { ValueCache } from '@wyw-in-js/processor-utils';
import type { RawSourceMap } from 'source-map';

import { applyOxcProcessors } from './applyOxcProcessors';
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
  inputSourceMap?: RawSourceMap
): OxcCollectResult => {
  const result = applyOxcProcessors(
    code,
    {
      filename,
      root,
    },
    options,
    (processor) => {
      processor.build(values);
      processor.doRuntimeReplacement();
    },
    true
  );
  const normalizedCode = normalizeRuntimeCode(result.code, filename);
  const map = createComposedRuntimeSourceMap(
    normalizedCode,
    code,
    filename,
    inputSourceMap
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
      dependencies: [],
      processors: result.processors,
      replacements: [],
      rules: {},
    },
  };
};
