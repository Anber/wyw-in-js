import {
  classifyHybridResolverSpecifier,
  defaultBundlerOwnedSpecifierPrefixes,
  getResolverPrecedence,
} from '../eval/resolverStrategy';

describe('resolverStrategy', () => {
  it('documents resolver precedence without changing bundler default behavior', () => {
    expect(getResolverPrecedence('bundler')).toEqual([
      'customResolver',
      'bundlerResolver',
      'nodeFallback',
    ]);

    expect(getResolverPrecedence('hybrid')).toEqual([
      'customResolver',
      'safeOxcResolver',
      'bundlerResolver',
      'nodeFallback',
    ]);

    expect(getResolverPrecedence('custom')).toEqual(['customResolver']);
    expect(getResolverPrecedence('node')).toEqual(['nodeFallback']);
  });

  it.each(defaultBundlerOwnedSpecifierPrefixes)(
    'routes bundler-owned prefix %s to the bundler resolver',
    (prefix) => {
      expect(classifyHybridResolverSpecifier(`${prefix}module`)).toEqual({
        reason: 'bundler-owned-prefix',
        route: 'bundler',
      });
    }
  );

  it('routes query and hash specifiers to the bundler resolver', () => {
    expect(classifyHybridResolverSpecifier('./asset.svg?raw')).toEqual({
      reason: 'query-or-hash',
      route: 'bundler',
    });

    expect(classifyHybridResolverSpecifier('./asset.svg#icon')).toEqual({
      reason: 'query-or-hash',
      route: 'bundler',
    });
  });

  it('routes relative specifiers to the Oxc-safe subset', () => {
    expect(classifyHybridResolverSpecifier('./tokens')).toEqual({
      reason: 'safe-relative-specifier',
      route: 'oxc',
    });

    expect(classifyHybridResolverSpecifier('../tokens')).toEqual({
      reason: 'safe-relative-specifier',
      route: 'oxc',
    });
  });

  it.each(['@scope/pkg', 'react', '#internal', '/src/app'])(
    'routes ambiguous specifier %s to the bundler resolver',
    (specifier) => {
      expect(classifyHybridResolverSpecifier(specifier)).toEqual({
        reason: 'ambiguous-specifier',
        route: 'bundler',
      });
    }
  );

  it('allows projects to mark additional prefixes as bundler-owned', () => {
    expect(
      classifyHybridResolverSpecifier('@app/virtual-entry', {
        bundlerOwnedPrefixes: ['@app/'],
      })
    ).toEqual({
      reason: 'bundler-owned-prefix',
      route: 'bundler',
    });
  });
});
