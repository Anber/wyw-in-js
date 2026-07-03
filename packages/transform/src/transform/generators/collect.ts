import { oxcShaker } from '../../shaker';
import { collectOxcRuntime } from '../../utils/collectOxcRuntime';
import type { ICollectAction, SyncScenarioForAction } from '../types';

/**
 * Parses the specified file, finds tags, applies run-time replacements,
 * removes dead code.
 */
// eslint-disable-next-line require-yield
export function* collect(
  this: ICollectAction
): SyncScenarioForAction<ICollectAction> {
  const { options } = this.services;
  const { prevalPayload } = this.data;
  const { entrypoint } = this;
  const { loadedAndParsed, name } = entrypoint;
  const preevalResult = entrypoint.getPreevalResult();

  if (loadedAndParsed.evaluator === 'ignored') {
    throw new Error('entrypoint was ignored');
  }

  if (loadedAndParsed.evaluator !== oxcShaker) {
    throw new Error(
      `[wyw-in-js] ${name} matched a legacy evaluator. The Oxc runtime path supports only the default Oxc evaluator.`
    );
  }

  const result = collectOxcRuntime(
    loadedAndParsed.code,
    name,
    options.root ?? process.cwd(),
    {
      ...options.pluginOptions,
      preserveSideEffectImportOrderLocals: new Set(
        preevalResult?.staticImportLocals ?? []
      ),
      preserveSideEffectImportLocals: new Set(
        preevalResult?.staticSideEffectImportLocals ?? []
      ),
    },
    prevalPayload.values,
    options.inputSourceMap
  );

  return {
    ast: null,
    code: result.code,
    map: result.map,
    metadata: result.metadata,
  };
}
