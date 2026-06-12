import {
  mergeOxcResolverAlias,
  toNativeResolverAlias,
} from '../nativeResolverOptions';

describe('nativeResolverOptions', () => {
  it('converts only static string aliases to native resolver aliases', () => {
    expect(
      toNativeResolverAlias([
        { find: '@', replacement: '/project/src' },
        { find: 'multi', replacement: ['/project/a', '/project/b'] },
        { name: 'webpack-array', alias: '/project/webpack' },
        { find: /^virtual:/, replacement: '/project/virtual' },
        { find: 'disabled', replacement: false },
      ])
    ).toEqual({
      '@': ['/project/src'],
      multi: ['/project/a', '/project/b'],
      'webpack-array': ['/project/webpack'],
    });
  });

  it('merges bundler aliases while preserving explicit oxc aliases', () => {
    expect(
      mergeOxcResolverAlias(
        {
          resolver: {
            alias: {
              '@': ['/custom/src'],
            },
            conditionNames: ['...'],
          },
        },
        {
          '@': ['/project/src'],
          '~': ['/project/node_modules'],
        }
      )
    ).toEqual({
      resolver: {
        alias: {
          '@': ['/custom/src'],
          '~': ['/project/node_modules'],
        },
        conditionNames: ['...'],
      },
    });
  });
});
