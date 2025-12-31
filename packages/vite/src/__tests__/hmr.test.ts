import path from 'path';

const transformMock = jest.fn();

jest.mock('vite', () => ({
  __esModule: true,
  optimizeDeps: jest.fn(),
  createFilter: () => () => true,
}));

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

    const reloadModule = jest.fn();
    const getModuleById = jest
      .fn()
      .mockImplementation((id: string) => ({ id }));

    const plugin = wywInJS();
    plugin.configResolved?.({ root } as any);
    plugin.configureServer?.({
      moduleGraph: { getModuleById },
      reloadModule,
    } as any);

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    expect(reloadModule).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();

    expect(getModuleById).toHaveBeenCalledWith(expectedCssFilename);
    expect(reloadModule).toHaveBeenCalledTimes(1);
  });

  it('does not reload CSS when generated CSS is unchanged', async () => {
    const { default: wywInJS } = await import('../index');
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');

    const reloadModule = jest.fn();
    const getModuleById = jest
      .fn()
      .mockImplementation((id: string) => ({ id }));

    const plugin = wywInJS();
    plugin.configResolved?.({ root } as any);
    plugin.configureServer?.({
      moduleGraph: { getModuleById },
      reloadModule,
    } as any);

    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      sourceMap: null,
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );
    jest.runOnlyPendingTimers();
    expect(reloadModule).toHaveBeenCalledTimes(1);

    reloadModule.mockClear();
    getModuleById.mockClear();

    transformMock.mockResolvedValue({
      code: 'export const x = 2;',
      sourceMap: null,
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test2")',
      entryId
    );
    jest.runOnlyPendingTimers();

    expect(reloadModule).not.toHaveBeenCalled();
  });
});
