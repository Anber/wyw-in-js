import path from 'path';

import * as babel from '@babel/core';

import type { StrictOptions } from '@wyw-in-js/shared';
import { logger } from '@wyw-in-js/shared';

import { TransformCacheCollection } from '../cache';
import { Entrypoint } from '../transform/Entrypoint';
import type { LoadAndParseFn } from '../transform/Entrypoint.types';
import { syncResolveImports } from '../transform/generators/resolveImports';
import type { IResolveImportsAction, Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const createPluginOptions = (
  overrides: StrictOptions['importOverrides']
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
  importOverrides: overrides,
  rules: [],
});

const createServices = ({
  filename,
  pluginOptions,
  root,
}: {
  filename: string;
  pluginOptions: StrictOptions;
  root: string;
}): Services => {
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
      root,
      pluginOptions,
    },
  };
};

describe('resolveImports: importOverrides', () => {
  it('applies file-key overrides based on resolved path', () => {
    const root = '/project';
    const pluginOptions = createPluginOptions({
      './src/foo.js': { noShake: true },
    });

    const services = createServices({
      filename: '/project/src/a.js',
      root,
      pluginOptions,
    });

    const resolve = () => '/project/src/foo.js';

    const entrypointA = Entrypoint.createRoot(
      services,
      '/project/src/a.js',
      ['*'],
      ''
    );
    const actionA = {
      data: { imports: new Map([['./foo', ['default']]]) },
      entrypoint: entrypointA,
      services,
    } as IResolveImportsAction;

    const depsA = syncResolveImports.call(actionA, resolve).next().value;
    expect(depsA).toEqual([
      {
        source: './foo',
        only: ['*'],
        resolved: '/project/src/foo.js',
      },
    ]);

    const entrypointB = Entrypoint.createRoot(
      services,
      '/project/other/b.js',
      ['*'],
      ''
    );
    const actionB = {
      data: { imports: new Map([['../src/foo.js', ['named']]]) },
      entrypoint: entrypointB,
      services,
    } as IResolveImportsAction;

    const depsB = syncResolveImports.call(actionB, resolve).next().value;
    expect(depsB).toEqual([
      {
        source: '../src/foo.js',
        only: ['*'],
        resolved: '/project/src/foo.js',
      },
    ]);
  });

  it('applies package-key overrides by source specifier', () => {
    const root = __dirname;
    const mockSpecifier = './__fixtures__/sample-script.js';

    const pluginOptions = createPluginOptions({
      react: {
        mock: mockSpecifier,
      },
    });

    const services = createServices({
      filename: path.join(root, 'a.js'),
      root,
      pluginOptions,
    });

    const entrypoint = Entrypoint.createRoot(
      services,
      path.join(root, 'a.js'),
      ['*'],
      ''
    );
    const action = {
      data: { imports: new Map([['react', ['default']]]) },
      entrypoint,
      services,
    } as IResolveImportsAction;

    const deps = syncResolveImports
      .call(action, () => '/external/react.js')
      .next().value;

    expect(deps).toEqual([
      {
        source: 'react',
        only: ['default'],
        resolved: require.resolve(path.resolve(root, mockSpecifier)),
      },
    ]);
  });
});
