import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import type {
  IWorkflowAction,
  SyncScenarioForAction,
} from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

// eslint-disable-next-line require-yield
const workflow = function* workflow(): SyncScenarioForAction<IWorkflowAction> {
  return {
    code: 'module.exports = 1;',
    sourceMap: null,
  };
};

const runTransform = (
  cache: TransformCacheCollection,
  eventEmitter: EventEmitter
) =>
  transform(
    {
      cache,
      eventEmitter,
      options: {
        filename: '/abs/entry.tsx',
        root: '/abs',
        pluginOptions: {
          configFile: false,
        },
      },
    },
    'export default 1;',
    async () => null,
    { workflow }
  );

describe('transform action context lifecycle', () => {
  it('recreates the workflow action after a successful transform', async () => {
    const cache = new TransformCacheCollection();
    let workflowActionsCreated = 0;
    const eventEmitter = new EventEmitter(
      () => {},
      () => 0,
      (_sequenceId, _timestamp, event) => {
        if (event.type === 'actionCreated' && event.actionType === 'workflow') {
          workflowActionsCreated += 1;
        }
      }
    );

    await runTransform(cache, eventEmitter);
    await runTransform(cache, eventEmitter);

    expect(workflowActionsCreated).toBe(2);
  });

  it('disposes the action context when action instrumentation throws', async () => {
    const cache = new TransformCacheCollection();
    let shouldThrow = true;
    let workflowActionsCreated = 0;
    const eventEmitter = new EventEmitter(
      () => {},
      () => 0,
      (_sequenceId, _timestamp, event) => {
        if (event.type !== 'actionCreated' || event.actionType !== 'workflow') {
          return;
        }

        workflowActionsCreated += 1;
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error('action instrumentation failed');
        }
      }
    );

    await expect(runTransform(cache, eventEmitter)).rejects.toThrow(
      'action instrumentation failed'
    );
    await expect(runTransform(cache, eventEmitter)).resolves.toMatchObject({
      code: 'module.exports = 1;',
    });

    expect(workflowActionsCreated).toBe(2);
  });
});
