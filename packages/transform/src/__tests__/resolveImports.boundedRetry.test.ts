import fs from 'fs';
import os from 'os';
import path from 'path';

import * as babel from '@babel/core';

import type { StrictOptions } from '@wyw-in-js/shared';
import { logger } from '@wyw-in-js/shared';

import { TransformCacheCollection } from '../cache';
import { Entrypoint } from '../transform/Entrypoint';
import type { LoadAndParseFn } from '../transform/Entrypoint.types';
import { asyncResolveImports } from '../transform/generators/resolveImports';
import type { IResolveImportsAction, Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const createPluginOptions = (
  overrides: Partial<StrictOptions> = {}
): StrictOptions => ({
  babelOptions: {},
  displayName: false,
  evaluate: true,
  extensions: ['.cjs', '.js', '.jsx', '.ts', '.tsx'],
  features: {
    dangerousCodeRemover: true,
    globalCache: true,
    happyDOM: true,
    softErrors: false,
    useBabelConfigs: true,
    useWeakRefInEval: true,
  },
  highPriorityPlugins: [],
  importOverrides: undefined,
  oxcOptions: {},
  rules: [],
  ...overrides,
});

const createServices = (
  filename: string,
  pluginOptions: Partial<StrictOptions> = {}
): Services => {
  const loadAndParseFn: LoadAndParseFn = (services, _name, loadedCode) => ({
    get ast() {
      return services.babel.parseSync(loadedCode ?? '')!;
    },
    code: loadedCode ?? '',
    evaluator: jest.fn(),
    evalConfig: {},
  });

  return {
    babel,
    cache: new TransformCacheCollection(),
    loadAndParseFn,
    log: logger,
    eventEmitter: EventEmitter.dummy,
    options: {
      filename,
      root: path.dirname(filename),
      pluginOptions: createPluginOptions(pluginOptions),
    },
  };
};

const drainAsync = async <T>(gen: AsyncGenerator<unknown, T>): Promise<T> => {
  while (true) {
    const next = await gen.next();
    if (next.done) {
      return next.value;
    }
  }
};

describe('asyncResolveImports — bounded retry on null resolutions', () => {
  it('prefers native resolution before bundler resolution in hybrid mode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-resolve-imports-'));
    const entryFile = path.join(root, 'entry.ts');
    const depFile = path.join(root, 'dep.ts');
    fs.writeFileSync(entryFile, 'import { value } from "./dep";');
    fs.writeFileSync(depFile, 'export const value = 1;');

    const services = createServices(entryFile, {
      eval: {
        resolver: 'hybrid',
      },
    });
    const entrypoint = Entrypoint.createRoot(services, entryFile, ['*'], '');
    const resolve = jest.fn(async () => path.join(root, 'bundler.ts'));

    const result = await drainAsync(
      asyncResolveImports.call(
        {
          data: { imports: new Map([['./dep', ['value']]]) },
          entrypoint,
          services,
        } as IResolveImportsAction,
        resolve
      )
    );

    expect(result).toEqual([
      {
        source: './dep',
        only: ['value'],
        resolved: fs.realpathSync(depFile),
      },
    ]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('falls back to bundler resolution in hybrid mode when native resolution misses', async () => {
    const services = createServices('/project/src/a.js', {
      eval: {
        resolver: 'hybrid',
      },
    });
    const entrypoint = Entrypoint.createRoot(
      services,
      '/project/src/a.js',
      ['*'],
      ''
    );
    const resolve = jest.fn(async () => '/project/src/alias.js');

    const result = await drainAsync(
      asyncResolveImports.call(
        {
          data: { imports: new Map([['@app/alias', ['value']]]) },
          entrypoint,
          services,
        } as IResolveImportsAction,
        resolve
      )
    );

    expect(result).toEqual([
      {
        source: '@app/alias',
        only: ['value'],
        resolved: '/project/src/alias.js',
      },
    ]);
    expect(resolve).toHaveBeenCalledWith('@app/alias', '/project/src/a.js', [
      '/project/src/a.js',
    ]);
  });

  it('prefers custom resolver before native and bundler resolution', async () => {
    const customResolver = jest.fn(async () => ({
      id: '/project/src/custom.js',
    }));
    const services = createServices('/project/src/a.js', {
      eval: {
        customResolver,
        resolver: 'hybrid',
      },
    });
    const entrypoint = Entrypoint.createRoot(
      services,
      '/project/src/a.js',
      ['*'],
      ''
    );
    const resolve = jest.fn(async () => '/project/src/bundler.js');

    const result = await drainAsync(
      asyncResolveImports.call(
        {
          data: { imports: new Map([['./dep', ['value']]]) },
          entrypoint,
          services,
        } as IResolveImportsAction,
        resolve
      )
    );

    expect(result).toEqual([
      {
        source: './dep',
        only: ['value'],
        resolved: '/project/src/custom.js',
      },
    ]);
    expect(customResolver).toHaveBeenCalledWith(
      './dep',
      '/project/src/a.js',
      'import'
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('retries a transient null resolution exactly once, then succeeds', async () => {
    const services = createServices('/project/src/a.js');
    const entrypoint = Entrypoint.createRoot(
      services,
      '/project/src/a.js',
      ['*'],
      ''
    );

    let attempt = 0;
    const resolve = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('transient resolver failure');
      }
      return '/project/src/foo.js';
    });

    const callResolve = () =>
      drainAsync(
        asyncResolveImports.call(
          {
            data: { imports: new Map([['./foo', ['default']]]) },
            entrypoint,
            services,
          } as IResolveImportsAction,
          resolve
        )
      );

    const first = await callResolve();
    expect(first).toEqual([]); // null filtered out
    expect(resolve).toHaveBeenCalledTimes(1);

    const second = await callResolve();
    expect(second).toEqual([
      {
        source: './foo',
        only: ['default'],
        resolved: '/project/src/foo.js',
      },
    ]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('caps retries at MAX_NULL_ATTEMPTS — persistent failures stop calling the resolver', async () => {
    const services = createServices('/project/src/a.js');
    const entrypoint = Entrypoint.createRoot(
      services,
      '/project/src/a.js',
      ['*'],
      ''
    );

    const resolve = jest.fn(async () => {
      throw new Error('persistent failure');
    });

    const callResolve = () =>
      drainAsync(
        asyncResolveImports.call(
          {
            data: { imports: new Map([['./foo', ['default']]]) },
            entrypoint,
            services,
          } as IResolveImportsAction,
          resolve
        )
      );

    // Many consumers hit the same failing source. Resolver must be called at
    // most MAX_NULL_ATTEMPTS times (currently 2), not once per consumer.
    for (let i = 0; i < 50; i += 1) {
      const result = await callResolve();
      expect(result).toEqual([]);
    }

    // Exactly 2 attempts: first call, then one bounded retry.
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('still dedupes concurrent in-flight requests for the same source', async () => {
    const services = createServices('/project/src/a.js');
    const entrypoint = Entrypoint.createRoot(
      services,
      '/project/src/a.js',
      ['*'],
      ''
    );

    let releaseResolver: ((value: string) => void) | null = null;
    const resolve = jest.fn(
      () =>
        new Promise<string>((resolve_) => {
          releaseResolver = resolve_;
        })
    );

    const callResolve = () =>
      drainAsync(
        asyncResolveImports.call(
          {
            data: { imports: new Map([['./foo', ['default']]]) },
            entrypoint,
            services,
          } as IResolveImportsAction,
          resolve
        )
      );

    const a = callResolve();
    const b = callResolve();

    await new Promise((r) => setImmediate(r));
    expect(resolve).toHaveBeenCalledTimes(1);

    releaseResolver!('/project/src/foo.js');

    const [resolvedA, resolvedB] = await Promise.all([a, b]);
    expect(resolvedA).toEqual([
      {
        source: './foo',
        only: ['default'],
        resolved: '/project/src/foo.js',
      },
    ]);
    expect(resolvedB).toEqual(resolvedA);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
