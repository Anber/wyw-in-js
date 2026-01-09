import path from 'path';

const transformMock = jest.fn();

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  logger: jest.fn(),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
}));

describe('webpack-loader asyncResolve', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('adds dependency without ?query/#hash', async () => {
    const { default: webpackLoader } = await import('../index');
    const addDependency = jest.fn();
    const resolveResult = `${path.resolve('assets/icon.svg')}?svgUse`;

    transformMock.mockImplementation(async (_services, _code, asyncResolve) => {
      await asyncResolve('./icon.svg?svgUse', '/abs/entry.tsx');
      return {
        code: _code,
        sourceMap: null,
        cssText: undefined,
        dependencies: [],
      };
    });

    const resolveModule = jest.fn((_ctx, _token, cb) =>
      cb(null, resolveResult)
    );

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          addDependency,
          async: jest.fn(),
          callback: (err: Error | null) => (err ? reject(err) : resolve()),
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => resolveModule,
          resourcePath: '/abs/entry.tsx',
        } as any,
        'module.exports = 1;',
        null
      );
    });

    expect(addDependency).toHaveBeenCalledWith(path.resolve('assets/icon.svg'));
  });

  it('uses root resolver for deep entrypoints via stack', async () => {
    const { default: webpackLoader } = await import('../index');
    const addDependency = jest.fn();
    const resolved = path.resolve('assets/deep.css');

    transformMock.mockImplementation(async (_services, _code, asyncResolve) => {
      await asyncResolve('./deep.css', '/abs/dependency.ts', [
        '/abs/dependency.ts',
        '/abs/entry.tsx',
      ]);
      return {
        code: _code,
        sourceMap: null,
        cssText: undefined,
        dependencies: [],
      };
    });

    const resolveModule = jest.fn((_ctx, _token, cb) => cb(null, resolved));

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          addDependency,
          async: jest.fn(),
          callback: (err: Error | null) => (err ? reject(err) : resolve()),
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => resolveModule,
          resourcePath: '/abs/entry.tsx',
        } as any,
        'module.exports = 1;',
        null
      );
    });

    expect(addDependency).toHaveBeenCalledWith(resolved);
  });
});
