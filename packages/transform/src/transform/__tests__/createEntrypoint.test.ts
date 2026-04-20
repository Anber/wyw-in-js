import type { Services } from '../types';

import { createEntrypoint, createServices } from './entrypoint-helpers';

describe('createEntrypoint', () => {
  let services: Services;

  beforeEach(() => {
    services = createServices();
  });

  it('should create a new entrypoint', () => {
    const entrypoint = createEntrypoint(services, '/foo/bar.js', ['default']);
    expect(entrypoint).toMatchObject({
      name: '/foo/bar.js',
      only: ['default'],
      parents: [],
    });
  });

  it('should take from cache', () => {
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);
    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['default']);
    expect(entrypoint1).toBe(entrypoint2);
  });

  it('should invalidate cache if source code was changed', () => {
    const entrypoint1 = createEntrypoint(
      services,
      '/foo/bar.js',
      ['default'],
      'foo'
    );
    const entrypoint2 = createEntrypoint(
      services,
      '/foo/bar.js',
      ['default'],
      'bar'
    );
    expect(entrypoint1).not.toBe(entrypoint2);
    expect(entrypoint1.supersededWith).toBe(entrypoint2);
  });

  it('should not take from cache if path differs', () => {
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);
    const entrypoint2 = createEntrypoint(services, '/foo/baz.js', ['default']);
    expect(entrypoint1).not.toBe(entrypoint2);
    expect(entrypoint1).toMatchObject({
      name: '/foo/bar.js',
      only: ['default'],
    });
    expect(entrypoint2).toMatchObject({
      name: '/foo/baz.js',
      only: ['default'],
    });
  });

  it('should not take from cache if only differs', () => {
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);
    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['named']);
    expect(entrypoint1).not.toBe(entrypoint2);
    expect(entrypoint1.supersededWith).toBe(entrypoint2);
    expect(entrypoint2).toMatchObject({
      name: '/foo/bar.js',
      only: ['default', 'named'],
    });
  });

  it('should take from cache if only is subset of cached', () => {
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', [
      'default',
      'named',
    ]);
    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['default']);
    expect(entrypoint1).toBe(entrypoint2);
  });

  it('should take from cache if wildcard is cached', () => {
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['*']);
    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['default']);
    expect(entrypoint1).toBe(entrypoint2);
  });

  it('should call callback if entrypoint was superseded', () => {
    const callback = jest.fn();
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);

    entrypoint1.onSupersede(callback);

    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['named']);
    expect(entrypoint1).not.toBe(entrypoint2);
    expect(entrypoint1.supersededWith).toBe(entrypoint2);
    expect(callback).toBeCalledWith(entrypoint2);
  });

  it('should not call supersede callback if it was unsubscribed', () => {
    const callback = jest.fn();
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['default']);

    const unsubscribe = entrypoint1.onSupersede(callback);
    unsubscribe();

    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['named']);
    expect(entrypoint1).not.toBe(entrypoint2);
    expect(entrypoint1.supersededWith).toBe(entrypoint2);
    expect(callback).not.toBeCalled();
  });

  it('should keep requested only for safe modules', () => {
    services.loadAndParseFn = jest.fn((s, name, loadedCode) => ({
      ast: s.babel.parseSync(loadedCode ?? '', {
        babelrc: false,
        configFile: false,
        filename: name,
      })!,
      code: loadedCode ?? '',
      evaluator: jest.fn(),
      evalConfig: {},
    }));

    const code = `
      export const a = 1;
      export const b = 2;
      export const c = { x: 'y' };
    `;

    const entrypoint1 = createEntrypoint(
      services,
      '/foo/tokens.ts',
      ['a'],
      code
    );
    expect(entrypoint1.only).toEqual(['a']);

    const entrypoint2 = createEntrypoint(
      services,
      '/foo/tokens.ts',
      ['b'],
      code
    );
    expect(entrypoint2).not.toBe(entrypoint1);
    expect(entrypoint2.only).toEqual(['a', 'b']);
  });

  it('reuses transformed state from evaluated cache when only is unchanged', () => {
    const loadAndParseFn = jest.fn((s, name, loadedCode) => ({
      ast: s.babel.parseSync(loadedCode ?? '', {
        babelrc: false,
        configFile: false,
        filename: name,
      })!,
      code: loadedCode ?? '',
      evaluator: jest.fn(),
      evalConfig: {},
    }));
    services.loadAndParseFn = loadAndParseFn;

    const code = 'export const value = 1;';
    const entrypoint1 = createEntrypoint(
      services,
      '/foo/bar.js',
      ['value'],
      code
    );
    entrypoint1.setTransformResult({ code, metadata: null });
    const evaluated = entrypoint1.createEvaluated();
    services.cache.add('entrypoints', '/foo/bar.js', evaluated);

    const entrypoint2 = createEntrypoint(
      services,
      '/foo/bar.js',
      ['value'],
      code
    );

    expect(loadAndParseFn).toHaveBeenCalledTimes(1);
    expect(services.cache.get('entrypoints', '/foo/bar.js')).toBe(evaluated);
    expect(entrypoint2.transformedCode).toBe(code);
    expect(entrypoint2.loadedAndParsed.code).toBe(code);
    expect(entrypoint2.loadedAndParsed).toBe(evaluated.loadedAndParsed);
  });

  it('reuses evaluated parsed state when only changes', () => {
    const loadAndParseFn = jest.fn((s, name, loadedCode) => ({
      ast: s.babel.parseSync(loadedCode ?? '', {
        babelrc: false,
        configFile: false,
        filename: name,
      })!,
      code: loadedCode ?? '',
      evaluator: jest.fn(),
      evalConfig: {},
    }));
    services.loadAndParseFn = loadAndParseFn;

    const code = 'export const a = 1; export const b = 2;';
    const entrypoint1 = createEntrypoint(services, '/foo/bar.js', ['a'], code);
    entrypoint1.setTransformResult({ code, metadata: null });
    const evaluated = entrypoint1.createEvaluated();
    services.cache.add('entrypoints', '/foo/bar.js', evaluated);

    const entrypoint2 = createEntrypoint(services, '/foo/bar.js', ['b'], code);

    expect(loadAndParseFn).toHaveBeenCalledTimes(1);
    expect(entrypoint2.loadedAndParsed).toBe(evaluated.loadedAndParsed);
  });
});
