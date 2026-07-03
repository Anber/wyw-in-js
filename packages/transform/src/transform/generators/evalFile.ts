import evaluate, { type IEvaluateResult } from '../../evaluators';
import { isUnprocessedEntrypointError } from '../actions/UnprocessedEntrypointError';
import { createPrevalPayload } from '../prevalPayload';
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
  const preevalResult = entrypoint.getPreevalResult();
  const filename =
    entrypoint.loadedAndParsed.evaluator === 'ignored'
      ? entrypoint.name
      : entrypoint.loadedAndParsed.evalConfig.filename ?? entrypoint.name;

  if (preevalResult && (preevalResult.dependencyNames?.length ?? 0) === 0) {
    const prevalPayload = createPrevalPayload({
      emitWarning: this.services.emitWarning,
      filename,
      staticDependencies: preevalResult.staticDependencies,
      staticValues: preevalResult.staticValueCache,
    });
    log(`<< skipped evaluate __wywPreval %O`, prevalPayload.values);

    return prevalPayload;
  }

  log(`>> evaluate __wywPreval`);

  let evaluated: IEvaluateResult | undefined;

  while (evaluated === undefined) {
    try {
      // eslint-disable-next-line no-await-in-loop
      evaluated = await this.services.eventEmitter.perf(
        'transform:evalFile',
        () => evaluate(this.services, entrypoint)
      );
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

  const prevalPayload = createPrevalPayload({
    emitWarning: this.services.emitWarning,
    evalDependencies: evaluated.dependencies,
    evalValues: evaluated.values,
    filename,
    staticDependencies: preevalResult?.staticDependencies,
    staticValues: preevalResult?.staticValueCache,
  });

  log(`<< evaluated __wywPreval %O`, prevalPayload.values);

  return prevalPayload;
}
