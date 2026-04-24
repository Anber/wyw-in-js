import type { Evaluator } from '@wyw-in-js/shared';

import { emitOxcCommonJS } from './utils/oxcEmit';
import { shakeOxcToESM } from './utils/oxcShaker';

export const oxcShaker: Evaluator = (evalConfig, ast, code, config) => {
  const filename = evalConfig.filename ?? 'unknown.js';
  const shaken = shakeOxcToESM(code, filename, config);
  const emitted = emitOxcCommonJS(shaken.code, filename);

  return [ast, emitted.code, shaken.imports];
};

export const shaker: Evaluator = oxcShaker;

export default shaker;
