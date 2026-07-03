/* eslint-env jest */
import { getEvalCacheKey } from '../transform/evalSession';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';

describe('getEvalCacheKey', () => {
  it('keeps the key stable when asyncResolveKey stays the same', () => {
    const pluginOptions = loadWywOptions({ configFile: false });
    const asyncResolveA = async () => null;
    const asyncResolveB = async () => null;

    expect(
      getEvalCacheKey(pluginOptions, 'webpack:compiler-a', asyncResolveA)
    ).toBe(getEvalCacheKey(pluginOptions, 'webpack:compiler-a', asyncResolveB));
  });

  it('changes the key when asyncResolveKey changes', () => {
    const pluginOptions = loadWywOptions({ configFile: false });

    expect(
      getEvalCacheKey(pluginOptions, 'webpack:compiler-a', async () => null)
    ).not.toBe(
      getEvalCacheKey(pluginOptions, 'webpack:compiler-b', async () => null)
    );
  });

  it('canonicalizes globals before hashing', () => {
    const asyncResolve = async () => null;
    const firstOptions = loadWywOptions({
      configFile: false,
      eval: {
        globals: {
          alpha: { first: 1, second: 2 },
          beta: ['x', 'y'],
        },
      },
    });
    const secondOptions = loadWywOptions({
      configFile: false,
      eval: {
        globals: {
          beta: ['x', 'y'],
          alpha: { second: 2, first: 1 },
        },
      },
    });

    expect(getEvalCacheKey(firstOptions, undefined, asyncResolve)).toBe(
      getEvalCacheKey(secondOptions, undefined, asyncResolve)
    );
  });
});
