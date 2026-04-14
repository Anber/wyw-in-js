import path from 'path';

import { MockDevEnvironment } from './viteMock';

const transformMock = jest.fn();

jest.mock('vite', () =>
  require('./viteMock').createViteMock({
    optimizeDeps: jest.fn(),
  })
);

jest.mock('@wyw-in-js/transform', () => {
  return {
    __esModule: true,
    createFileReporter: () => ({
      emitter: { single: jest.fn() },
      onDone: jest.fn(),
    }),
    getFileIdx: () => '1',
    TransformCacheCollection: class TransformCacheCollection {},
    transform: (...args: unknown[]) => transformMock(...args),
  };
});

describe('vite HMR', () => {
  beforeEach(() => {
    transformMock.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('defers reloadModule for generated CSS until after transform()', async () => {
    const { default: wywInJS } = await import('../index');
    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      sourceMap: null,
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
    });

    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');
    const expectedCssFilename = path
      .normalize(`${entryId.replace(/\.[jt]sx?$/, '')}.wyw-in-js.css`)
      .replace(/\\/g, path.posix.sep);

    const environment = new MockDevEnvironment();
    environment.moduleGraph.getModuleById.mockImplementation((id: string) => ({
      id,
    }));

    const plugin = wywInJS();
    plugin.configResolved?.({
      root,
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);
    plugin.configureServer?.({
      moduleGraph: { getModuleById: jest.fn() },
    } as any);

    await plugin.transform?.call(
      { resolve: jest.fn(), environment } as any,
      'console.log("test")',
      entryId
    );

    expect(environment.reloadModule).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();

    expect(environment.moduleGraph.getModuleById).toHaveBeenCalledWith(
      expectedCssFilename
    );
    expect(environment.reloadModule).toHaveBeenCalledTimes(1);
  });

  it('does not reload CSS when generated CSS is unchanged', async () => {
    const { default: wywInJS } = await import('../index');
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');

    const environment = new MockDevEnvironment();
    environment.moduleGraph.getModuleById.mockImplementation((id: string) => ({
      id,
    }));

    const plugin = wywInJS();
    plugin.configResolved?.({
      root,
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);
    plugin.configureServer?.({
      moduleGraph: { getModuleById: jest.fn() },
    } as any);

    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      sourceMap: null,
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), environment } as any,
      'console.log("test")',
      entryId
    );
    jest.runOnlyPendingTimers();
    expect(environment.reloadModule).toHaveBeenCalledTimes(1);

    environment.reloadModule.mockClear();
    environment.moduleGraph.getModuleById.mockClear();

    transformMock.mockResolvedValue({
      code: 'export const x = 2;',
      sourceMap: null,
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn(), environment } as any,
      'console.log("test2")',
      entryId
    );
    jest.runOnlyPendingTimers();

    expect(environment.reloadModule).not.toHaveBeenCalled();
  });
});
