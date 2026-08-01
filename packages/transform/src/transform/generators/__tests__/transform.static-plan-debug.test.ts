/* eslint-env jest */
import { EventEmitter } from '../../../utils/EventEmitter';
import type { ITransformAction } from '../../types';
import { emitCurrentStaticPlanDebug } from '../transform';

const filename = '/project/src/entry.tsx';

describe('emitCurrentStaticPlanDebug', () => {
  it('does not inspect the entrypoint without a staticPlan listener', () => {
    const eventEmitter = new EventEmitter(
      () => {},
      () => 0,
      () => {},
      true,
      { debugEvents: [] }
    );
    let entrypointRead = false;
    const action = {
      get entrypoint(): never {
        entrypointRead = true;
        throw new Error('entrypoint should not be read');
      },
      services: { eventEmitter },
    } as unknown as ITransformAction;

    expect(() => emitCurrentStaticPlanDebug(action, null)).not.toThrow();
    expect(entrypointRead).toBe(false);
  });

  it('builds and emits the plan for a legacy listener', () => {
    const events: Record<string, unknown>[] = [];
    const eventEmitter = new EventEmitter(
      (labels, type) => {
        if (type === 'single') {
          events.push(labels);
        }
      },
      () => 0,
      () => {}
    );
    const code = `export const color = 'red';`;
    const action = {
      entrypoint: {
        getPreevalResult: () => ({ ast: null, code, metadata: null }),
        loadedAndParsed: {
          code,
          evalConfig: { filename },
          evaluator: () => {},
        },
        name: filename,
      },
      services: {
        eventEmitter,
        options: { pluginOptions: {} },
      },
    } as unknown as ITransformAction;

    emitCurrentStaticPlanDebug(action, null);

    expect(events).toEqual([
      expect.objectContaining({ filename, type: 'staticPlan' }),
    ]);
  });
});
