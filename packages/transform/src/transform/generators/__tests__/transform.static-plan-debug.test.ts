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

  it('emits cached attribution without reparsing the source', () => {
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
    const action = {
      entrypoint: {
        getPreevalResult: () => ({
          ast: null,
          code: '',
          dependencyNames: ['_exp2'],
          metadata: null,
          staticDependencies: ['./runtime.css'],
          staticPlanFacts: {
            importedNeeds: [{ name: 'color', source: './tokens' }],
            staticValueCount: 1,
            unresolvedCount: 1,
            usageCount: 2,
          },
          staticValueCache: new Map([['_exp', 'red']]),
        }),
        loadedAndParsed: {
          get code(): never {
            throw new Error('source should not be reparsed');
          },
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

    emitCurrentStaticPlanDebug(
      action,
      new Map([
        ['./runtime.css', ['side-effect']],
        ['./runtime.js', ['default']],
      ])
    );

    expect(events).toEqual([
      expect.objectContaining({
        filename,
        needCount: 2,
        needRequestCount: 2,
        runtimeDependencyCount: 2,
        staticValueCount: 1,
        type: 'staticPlan',
        unresolvedCount: 1,
        usageCount: 2,
      }),
    ]);
  });
});
