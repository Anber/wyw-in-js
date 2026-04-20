const getEvalBrokerMock = jest.fn();
const createRootMock = jest.fn();
const asyncActionRunnerMock = jest.fn();

jest.mock('../eval/broker', () => ({
  __esModule: true,
  getEvalBroker: (...args: unknown[]) => getEvalBrokerMock(...args),
}));

jest.mock('../transform/Entrypoint', () => ({
  __esModule: true,
  Entrypoint: {
    createRoot: (...args: unknown[]) => createRootMock(...args),
  },
}));

jest.mock('../transform/actions/actionRunner', () => ({
  __esModule: true,
  asyncActionRunner: (...args: unknown[]) => asyncActionRunnerMock(...args),
}));

jest.mock('../transform/generators', () => ({
  __esModule: true,
  baseHandlers: {},
}));

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';

describe('transform asyncResolveKey', () => {
  beforeEach(() => {
    getEvalBrokerMock.mockReset().mockReturnValue(undefined);
    asyncActionRunnerMock.mockReset().mockResolvedValue({
      code: 'module.exports = 1;',
      sourceMap: null,
    });
    createRootMock.mockReset().mockImplementation((_services, filename) => ({
      createAction: jest.fn(() => ({})),
      ignored: false,
      log: jest.fn(),
      name: filename,
    }));
  });

  it('keeps eval cache key stable when asyncResolveKey stays the same', async () => {
    const cache = new TransformCacheCollection();
    const cachedEntrypoint = {
      dependencies: new Map<string, { resolved: string | null }>(),
    };
    const asyncResolveA = async () => null;
    const asyncResolveB = async () => null;

    await transform(
      {
        asyncResolveKey: 'webpack:compiler-a',
        cache,
        options: {
          filename: '/abs/entry-a.tsx',
          root: '/abs',
          pluginOptions: {
            configFile: false,
          },
        },
      },
      'export default 1;',
      asyncResolveA
    );

    const firstKey = getEvalBrokerMock.mock.calls[0][2];
    cache.add('entrypoints', '/abs/shared.ts', cachedEntrypoint);

    await transform(
      {
        asyncResolveKey: 'webpack:compiler-a',
        cache,
        options: {
          filename: '/abs/entry-b.tsx',
          root: '/abs',
          pluginOptions: {
            configFile: false,
          },
        },
      },
      'export default 1;',
      asyncResolveB
    );

    expect(getEvalBrokerMock.mock.calls[1][2]).toBe(firstKey);
    expect(cache.get('entrypoints', '/abs/shared.ts')).toBe(cachedEntrypoint);
  });

  it('separates eval cache key when asyncResolveKey changes', async () => {
    const cache = new TransformCacheCollection();
    const cachedEntrypoint = {
      dependencies: new Map<string, { resolved: string | null }>(),
    };

    await transform(
      {
        asyncResolveKey: 'webpack:compiler-a',
        cache,
        options: {
          filename: '/abs/entry-a.tsx',
          root: '/abs',
          pluginOptions: {
            configFile: false,
          },
        },
      },
      'export default 1;',
      async () => null
    );

    const firstKey = getEvalBrokerMock.mock.calls[0][2];
    cache.add('entrypoints', '/abs/shared.ts', cachedEntrypoint);

    await transform(
      {
        asyncResolveKey: 'webpack:compiler-b',
        cache,
        options: {
          filename: '/abs/entry-b.tsx',
          root: '/abs',
          pluginOptions: {
            configFile: false,
          },
        },
      },
      'export default 1;',
      async () => null
    );

    expect(getEvalBrokerMock.mock.calls[1][2]).not.toBe(firstKey);
    expect(cache.get('entrypoints', '/abs/shared.ts')).toBeUndefined();
  });
});
