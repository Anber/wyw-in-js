import { syncActionRunner } from '../../actions/actionRunner';
import {
  createEntrypoint,
  createServices,
  getHandlers,
} from '../../__tests__/entrypoint-helpers';
import { processEntrypoint } from '../processEntrypoint';

describe('processEntrypoint', () => {
  it('skips transform when the entrypoint is already transformed', () => {
    const services = createServices();
    const entrypoint = createEntrypoint(
      services,
      '/foo/entry.js',
      ['value'],
      'export const value = 1;'
    );
    entrypoint.setTransformResult({
      code: 'export const value = 1;',
      metadata: null,
    });

    const handlers = getHandlers<'sync'>({
      processEntrypoint,
    });

    const action = entrypoint.createAction(
      'processEntrypoint',
      undefined,
      null
    );

    syncActionRunner(action, handlers);

    expect(handlers.transform).not.toHaveBeenCalled();
  });
});
