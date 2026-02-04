import type { ValueCache } from '@wyw-in-js/processor-utils';

import evaluate, { type IEvaluateResult } from '../../evaluators';
import { isUnprocessedEntrypointError } from '../actions/UnprocessedEntrypointError';
import type { AsyncScenarioForAction, IEvalAction } from '../types';

/**
 * Executes the code prepared in previous steps within the current `Entrypoint`.
 * Returns all exports that were requested in `only`.
 */
// eslint-disable-next-line require-yield
export async function* evalFile(
  this: IEvalAction
): AsyncScenarioForAction<IEvalAction> {
  const { entrypoint } = this;
  const { log } = entrypoint;

  log(`>> evaluate __wywPreval`);

  let evaluated: IEvaluateResult | undefined;

  while (evaluated === undefined) {
    try {
      // eslint-disable-next-line no-await-in-loop
      evaluated = await evaluate(this.services, entrypoint);
    } catch (e) {
      if (isUnprocessedEntrypointError(e)) {
        entrypoint.log(
          'Evaluation has been aborted because one if the required files is not processed. Schedule reprocessing and repeat evaluation.'
        );
        yield ['processEntrypoint', e.entrypoint, undefined];
      } else {
        throw e;
      }
    }
  }

  if (!evaluated.values) {
    return null;
  }

  const valueCache: ValueCache = evaluated.values;

  log(`<< evaluated __wywPreval %O`, valueCache);

  return [valueCache, evaluated.dependencies];
}
