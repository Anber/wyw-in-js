import path from 'path';

import webpackLoader from '..';

const transformMock = jest.fn();

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  TransformCacheCollection: class TransformCacheCollection {},
  transform: (...args: unknown[]) => transformMock(...args),
}));

describe('webpack-loader asyncResolve', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('adds dependency without ?query/#hash', async () => {
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
});
