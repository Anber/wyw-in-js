const createLogger = () => {
  const log = (() => undefined) as unknown as ((...args: unknown[]) => void) & {
    extend: (...args: unknown[]) => unknown;
  };

  log.extend = () => log;
  return log;
};

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  logger: createLogger(),
  syncResolve: jest.fn(),
}));

jest.mock('vite', () => ({
  __esModule: true,
  createFilter: () => () => true,
  loadEnv: jest.fn(() => ({})),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  getFileIdx: () => '1',
  TransformCacheCollection: class TransformCacheCollection {},
  transform: jest.fn(),
}));

describe('vite preserveCssPaths', () => {
  it('rewrites wyw css assets to preserve directories', async () => {
    const { default: wywInJS } = await import('../index');

    const outputOptions = {
      preserveModules: true,
      preserveModulesRoot: '/project/src',
      assetFileNames: 'assets/[name].[hash].[ext]',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { rollupOptions: { output: outputOptions } },
    } as any);

    expect(typeof outputOptions.assetFileNames).toBe('function');

    expect(
      (outputOptions.assetFileNames as any)({
        name: 'src/components/button.wyw-in-js.css',
        type: 'asset',
      })
    ).toBe('assets/components/[name].[hash].[ext]');

    expect(
      (outputOptions.assetFileNames as any)({
        name: '/project/src/components/button.wyw-in-js.css',
        type: 'asset',
      })
    ).toBe('assets/components/[name].[hash].[ext]');

    expect(
      (outputOptions.assetFileNames as any)({
        name: 'src/styles/app.css',
        type: 'asset',
      })
    ).toBe('assets/[name].[hash].[ext]');
  });

  it('preserves hash-only assetFileNames templates', async () => {
    const { default: wywInJS } = await import('../index');

    const outputOptions = {
      preserveModules: true,
      preserveModulesRoot: '/project/src',
      assetFileNames: 'assets/[hash].css',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { rollupOptions: { output: outputOptions } },
    } as any);

    expect(typeof outputOptions.assetFileNames).toBe('function');

    expect(
      (outputOptions.assetFileNames as any)({
        name: 'src/components/button.wyw-in-js.css',
        type: 'asset',
      })
    ).toBe('assets/components/[hash].css');

    expect(
      (outputOptions.assetFileNames as any)({
        name: 'src/styles/app.css',
        type: 'asset',
      })
    ).toBe('assets/[hash].css');
  });

  it('keeps fixed assetFileNames values intact', async () => {
    const { default: wywInJS } = await import('../index');

    const outputOptions = {
      preserveModules: true,
      preserveModulesRoot: '/project/src',
      assetFileNames: 'assets/fixed.css',
    };

    const plugin = wywInJS({ preserveCssPaths: true });
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { rollupOptions: { output: outputOptions } },
    } as any);

    expect(typeof outputOptions.assetFileNames).toBe('function');

    expect(
      (outputOptions.assetFileNames as any)({
        name: 'src/components/button.wyw-in-js.css',
        type: 'asset',
      })
    ).toBe('assets/fixed.css');
  });

  it('does not change output naming when preserveCssPaths is disabled', async () => {
    const { default: wywInJS } = await import('../index');

    const outputOptions = {
      preserveModules: true,
      preserveModulesRoot: '/project/src',
      assetFileNames: 'assets/[name].[hash].[ext]',
    };

    const plugin = wywInJS();
    plugin.configResolved?.({
      root: '/project',
      mode: 'production',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
      build: { rollupOptions: { output: outputOptions } },
    } as any);

    expect(outputOptions.assetFileNames).toBe('assets/[name].[hash].[ext]');
  });
});
