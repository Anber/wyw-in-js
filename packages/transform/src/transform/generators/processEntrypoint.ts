import { isAborted } from '../actions/AbortError';
import type {
  AsyncScenarioForAction,
  IProcessEntrypointAction,
  SyncScenarioForAction,
} from '../types';

/**
 * The first stage of processing an entrypoint.
 * This stage is responsible for:
 * - scheduling the transform action
 * - rescheduling itself if the entrypoint is superseded
 */
export function* processEntrypoint(
  this: IProcessEntrypointAction
): SyncScenarioForAction<IProcessEntrypointAction> {
  const { only, log } = this.entrypoint;
  log('start processing (only: %o)', only);

  if (this.entrypoint.transformed) {
    log('already transformed, skip processing');
    return;
  }

  if (this.entrypoint.isProcessing) {
    log('already processing, skip duplicate request');
    return;
  }

  this.entrypoint.beginProcessing();

  try {
    using abortSignal = this.createAbortSignal();

    const result = yield* this.getNext(
      'transform',
      this.entrypoint,
      undefined,
      abortSignal
    );

    this.entrypoint.assertNotSuperseded();

    this.entrypoint.setTransformResult(result);

    const supersededWith = this.entrypoint.applyDeferredSupersede();
    if (supersededWith) {
      log('processing finished, deferred only detected; schedule next attempt');
      yield* this.getNext('processEntrypoint', supersededWith, undefined, null);
      return;
    }

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
  } finally {
    this.entrypoint.endProcessing();
  }
}

export async function* processEntrypointAsync(
  this: IProcessEntrypointAction
): AsyncScenarioForAction<IProcessEntrypointAction> {
  const { only, log } = this.entrypoint;
  log('start processing (only: %o)', only);

  if (this.entrypoint.transformed) {
    log('already transformed, skip processing');
    return;
  }

  if (this.entrypoint.isProcessing) {
    log('already processing, wait for existing request');
    await this.entrypoint.waitForProcessing();
    return;
  }

  this.entrypoint.beginProcessing();

  try {
    using abortSignal = this.createAbortSignal();

    const result = yield* this.getNext(
      'transform',
      this.entrypoint,
      undefined,
      abortSignal
    );

    this.entrypoint.assertNotSuperseded();

    this.entrypoint.setTransformResult(result);

    const supersededWith = this.entrypoint.applyDeferredSupersede();
    if (supersededWith) {
      log('processing finished, deferred only detected; schedule next attempt');
      yield* this.getNext('processEntrypoint', supersededWith, undefined, null);
      return;
    }

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
  } finally {
    this.entrypoint.endProcessing();
  }
}
