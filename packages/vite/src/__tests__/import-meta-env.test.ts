const loadEnvMock = jest.fn(() => ({ VITE_COLOR: 'red' }));
const transformMock = jest.fn();

jest.mock('vite', () => ({
  __esModule: true,
  createFilter: () => () => true,
  loadEnv: (...args: unknown[]) => loadEnvMock(...args),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  getFileIdx: () => '1',
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
}));

describe('vite import.meta.env injection', () => {
  beforeEach(() => {
    loadEnvMock.mockClear();
    transformMock.mockReset();
    transformMock.mockResolvedValue({
      code: '',
      sourceMap: null,
      cssText: undefined,
      dependencies: [],
    });
  });

  it('injects Vite env values into VM context (client/SSR)', async () => {
    const { default: wywInJS } = await import('../index');

    const plugin = wywInJS();
    plugin.configResolved?.({
      root: '/root',
      mode: 'development',
      command: 'serve',
      base: '/base/',
      envDir: '/root',
      envPrefix: 'VITE_',
    } as any);

    await plugin.transform?.call(
      {
        resolve: jest.fn(),
        warn: jest.fn(),
      } as any,
      'console.log("test")',
      '/entry.tsx'
    );

    const firstServices = transformMock.mock.calls[0][0];
    const firstOverrideContext =
      firstServices.options.pluginOptions.overrideContext;

    const clientContext = firstOverrideContext({}, '/entry.tsx');
    expect(clientContext.__wyw_import_meta_env).toEqual(
      expect.objectContaining({
        VITE_COLOR: 'red',
        BASE_URL: '/base/',
        MODE: 'development',
        DEV: true,
        PROD: false,
        SSR: false,
      })
    );

    await plugin.transform?.call(
      {
        resolve: jest.fn(),
        warn: jest.fn(),
      } as any,
      'console.log("test")',
      '/entry.tsx',
      { ssr: true }
    );

    const secondServices = transformMock.mock.calls[1][0];
    const secondOverrideContext =
      secondServices.options.pluginOptions.overrideContext;

    const ssrContext = secondOverrideContext({}, '/entry.tsx');
    expect(ssrContext.__wyw_import_meta_env).toEqual(
      expect.objectContaining({
        SSR: true,
      })
    );
  });
});
