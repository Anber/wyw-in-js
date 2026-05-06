import { getResolverPrecedence } from '../eval/resolverStrategy';

describe('resolverStrategy', () => {
  it('documents native resolver precedence without changing bundler default behavior', () => {
    expect(getResolverPrecedence('bundler')).toEqual([
      'customResolver',
      'bundlerResolver',
      'nativeFallback',
    ]);

    expect(getResolverPrecedence('hybrid')).toEqual([
      'customResolver',
      'nativeResolver',
      'bundlerResolver',
    ]);

    expect(getResolverPrecedence('custom')).toEqual(['customResolver']);
    expect(getResolverPrecedence('native')).toEqual(['nativeResolver']);
  });
});
