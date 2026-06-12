import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import type {
  IWorkflowAction,
  SyncScenarioForAction,
} from '../transform/types';

// eslint-disable-next-line require-yield
const workflow = function* workflow(): SyncScenarioForAction<IWorkflowAction> {
  return {
    code: 'module.exports = 1;',
    sourceMap: null,
  };
};

describe('transform asyncResolveKey', () => {
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
      asyncResolveA,
      { workflow }
    );

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
      asyncResolveB,
      { workflow }
    );

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
      async () => null,
      { workflow }
    );

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
      async () => null,
      { workflow }
    );

    expect(cache.get('entrypoints', '/abs/shared.ts')).toBeUndefined();
  });
});
