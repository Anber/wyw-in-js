import { syncActionRunner } from '../../actions/actionRunner';
import {
  createEntrypoint,
  createServices,
  getHandlers,
} from '../../__tests__/entrypoint-helpers';
import { processImports } from '../processImports';

describe('processImports', () => {
  it('reuses fresh transformed dependencies without reprocessing them', () => {
    const services = createServices();
    const parent = createEntrypoint(
      services,
      '/foo/parent.js',
      ['__wywPreval'],
      'import { value } from "./dep.js";'
    );
    const depPath = '/foo/dep.js';
    const depCode = 'export const value = 1;';
    const depEntrypoint = createEntrypoint(
      services,
      depPath,
      ['value'],
      depCode
    );
    depEntrypoint.setTransformResult({ code: depCode, metadata: null });

    services.cache.add('entrypoints', depPath, depEntrypoint);

    const freshnessSpy = jest
      .spyOn(services.cache, 'checkFreshness')
      .mockReturnValue(false);
    const createChildSpy = jest.spyOn(parent, 'createChild');
    const handlers = getHandlers<'sync'>({
      processImports,
    });

    const action = parent.createAction(
      'processImports',
      {
        resolved: [
          {
            only: ['value'],
            resolved: depPath,
            source: './dep.js',
          },
        ],
      },
      null
    );

    syncActionRunner(action, handlers);

    expect(freshnessSpy).toHaveBeenCalledWith(depPath, depPath);
    expect(createChildSpy).not.toHaveBeenCalled();
    expect(handlers.processEntrypoint).not.toHaveBeenCalled();
    expect(depEntrypoint.parents).toContain(parent);
  });

  it('reuses fresh evaluated dependencies without reprocessing them', () => {
    const services = createServices();
    const parent = createEntrypoint(
      services,
      '/foo/parent.js',
      ['__wywPreval'],
      'import { value } from "./dep.js";'
    );
    const depPath = '/foo/dep.js';
    const depCode = 'export const value = 1;';
    const depEntrypoint = createEntrypoint(
      services,
      depPath,
      ['value'],
      depCode
    );
    depEntrypoint.setTransformResult({ code: depCode, metadata: null });

    const evaluated = depEntrypoint.createEvaluated();
    services.cache.add('entrypoints', depPath, evaluated);

    const freshnessSpy = jest
      .spyOn(services.cache, 'checkFreshness')
      .mockReturnValue(false);
    const createChildSpy = jest.spyOn(parent, 'createChild');
    const handlers = getHandlers<'sync'>({
      processImports,
    });

    const action = parent.createAction(
      'processImports',
      {
        resolved: [
          {
            only: ['value'],
            resolved: depPath,
            source: './dep.js',
          },
        ],
      },
      null
    );

    syncActionRunner(action, handlers);

    expect(freshnessSpy).toHaveBeenCalledWith(depPath, depPath);
    expect(createChildSpy).not.toHaveBeenCalled();
    expect(handlers.processEntrypoint).not.toHaveBeenCalled();
    expect(evaluated.parents).toContain(parent);
  });

  it('reprocesses evaluated dependencies when freshness check invalidates them', () => {
    const services = createServices();
    const parent = createEntrypoint(
      services,
      '/foo/parent.js',
      ['__wywPreval'],
      'import { value } from "./dep.js";'
    );
    const depPath = '/foo/dep.js';
    const depEntrypoint = createEntrypoint(
      services,
      depPath,
      ['value'],
      'export const value = 1;'
    );
    depEntrypoint.setTransformResult({
      code: 'export const value = 1;',
      metadata: null,
    });

    services.cache.add('entrypoints', depPath, depEntrypoint.createEvaluated());

    jest.spyOn(services.cache, 'checkFreshness').mockReturnValue(true);
    const createChildSpy = jest.spyOn(parent, 'createChild');
    const handlers = getHandlers<'sync'>({
      processImports,
    });

    const action = parent.createAction(
      'processImports',
      {
        resolved: [
          {
            only: ['value'],
            resolved: depPath,
            source: './dep.js',
          },
        ],
      },
      null
    );

    syncActionRunner(action, handlers);

    expect(createChildSpy).toHaveBeenCalledWith(depPath, ['value']);
    expect(handlers.processEntrypoint).toHaveBeenCalledTimes(1);
  });
});
