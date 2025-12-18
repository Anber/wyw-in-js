import wywInJS from '..';

const optimizeDepsMock = jest.fn();
const asyncResolveResults: Array<string | null> = [];

jest.mock('vite', () => ({
  __esModule: true,
  optimizeDeps: (...args: unknown[]) => optimizeDepsMock(...args),
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
    transform: jest.fn(async (_services, _code, asyncResolve) => {
      const resolved = await asyncResolve('/@react-refresh', '/entry.tsx', []);
      asyncResolveResults.push(resolved);
      return {
        code: _code,
        sourceMap: null,
        cssText: undefined,
        dependencies: [],
      };
    }),
  };
});

describe('vite asyncResolve', () => {
  it('ignores Vite virtual ids like /@react-refresh', async () => {
    const plugin = wywInJS();

    plugin.configResolved({ root: process.cwd() } as any);

    const resolveMock = jest.fn().mockResolvedValue({
      id: '/@react-refresh',
      external: false,
    });

    await plugin.transform?.call(
      { resolve: resolveMock } as any,
      'console.log("test")',
      '/entry.tsx'
    );

    expect(optimizeDepsMock).not.toHaveBeenCalled();
    expect(asyncResolveResults).toContain(null);
  });
});
