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

  it('falls back to the current loader resolver when the stacked root resolver is gone', async () => {
    const { default: webpackLoader } = await import('../index');
    const resolved = path.resolve('assets/deep.css');
    const addDependencyA = jest.fn();
    const addDependencyB = jest.fn();
    const resolveModuleA = jest.fn((_ctx, _token, cb) => cb(null, resolved));
    const resolveModuleB = jest.fn((_ctx, _token, cb) => cb(null, resolved));

    transformMock.mockImplementation(async (services, _code, asyncResolve) => {
      if (services.options.filename === '/abs/entry-a.tsx') {
        return {
          code: _code,
          sourceMap: null,
          cssText: undefined,
          dependencies: [],
        };
      }

      await asyncResolve('./deep.css', '/abs/dependency.ts', [
        '/abs/dependency.ts',
        '/abs/entry-a.tsx',
      ]);

      return {
        code: _code,
        sourceMap: null,
        cssText: undefined,
        dependencies: [],
      };
    });

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          addDependency: addDependencyA,
          async: jest.fn(),
          callback: (err: Error | null) => (err ? reject(err) : resolve()),
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => resolveModuleA,
          resourcePath: '/abs/entry-a.tsx',
        } as any,
        'module.exports = 1;',
        null
      );
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(resolveModuleA).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          addDependency: addDependencyB,
          async: jest.fn(),
          callback: (err: Error | null) => (err ? reject(err) : resolve()),
          emitWarning: jest.fn(),
          getOptions: () => ({}),
          getResolve: () => resolveModuleB,
          resourcePath: '/abs/entry-b.tsx',
        } as any,
        'module.exports = 1;',
        null
      );
    });

    expect(resolveModuleA).not.toHaveBeenCalled();
    expect(resolveModuleB).toHaveBeenCalledTimes(1);
    expect(addDependencyB).toHaveBeenCalledWith(resolved);
  });
});
