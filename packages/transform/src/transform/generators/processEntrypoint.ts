import { shaker } from '../../shaker';
import { isAborted } from '../actions/AbortError';
import { analyzeBarrelFile } from '../barrelManifest';
import type { IProcessEntrypointAction, SyncScenarioForAction } from '../types';

const shouldSkipExplodeReexports = (
  action: IProcessEntrypointAction
): boolean => {
  const { loadedAndParsed } = action.entrypoint;
  return (
    loadedAndParsed.evaluator === shaker &&
    analyzeBarrelFile(loadedAndParsed.ast).kind === 'barrel'
  );
};

/**
 * The first stage of processing an entrypoint.
 * This stage is responsible for:
 * - scheduling the explodeReexports action
 * - scheduling the transform action
 * - rescheduling itself if the entrypoint is superseded
 */
export function* processEntrypoint(
  this: IProcessEntrypointAction
): SyncScenarioForAction<IProcessEntrypointAction> {
  const { only, log } = this.entrypoint;
  log('start processing (only: %o)', only);

  try {
    using abortSignal = this.createAbortSignal();

    if (shouldSkipExplodeReexports(this)) {
      log('skip explodeReexports for pure barrel');
    } else {
      yield ['explodeReexports', this.entrypoint, undefined, abortSignal];
    }
    const result = yield* this.getNext(
      'transform',
      this.entrypoint,
      undefined,
      abortSignal
    );

    this.entrypoint.assertNotSuperseded();

    this.entrypoint.setTransformResult(result);

    log('entrypoint processing finished');
  } catch (e) {
    if (isAborted(e) && this.entrypoint.supersededWith) {
      log('processing aborted, schedule the next attempt');
      yield* this.getNext(
        'processEntrypoint',
        this.entrypoint.supersededWith,
        undefined,
        null
      );

      return;
    }

    log(`Unhandled error: %O`, e);
    throw e;
  }
}
