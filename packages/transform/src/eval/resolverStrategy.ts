import type { EvalResolverMode } from '@wyw-in-js/shared';

export type HybridResolverRoute = 'bundler' | 'oxc';

export type HybridResolverReason =
  | 'ambiguous-specifier'
  | 'bundler-owned-prefix'
  | 'query-or-hash'
  | 'safe-relative-specifier';

export type HybridResolverDecision = {
  reason: HybridResolverReason;
  route: HybridResolverRoute;
};

export type HybridResolverClassifierOptions = {
  bundlerOwnedPrefixes?: readonly string[];
};

export const defaultBundlerOwnedSpecifierPrefixes = [
  '\0',
  '/@',
  'virtual:',
] as const;

export const getResolverPrecedence = (
  mode: EvalResolverMode
): readonly string[] => {
  if (mode === 'hybrid') {
    return [
      'customResolver',
      'safeOxcResolver',
      'bundlerResolver',
      'nodeFallback',
    ];
  }

  if (mode === 'bundler') {
    return ['customResolver', 'bundlerResolver', 'nodeFallback'];
  }

  if (mode === 'custom') {
    return ['customResolver'];
  }

  return ['nodeFallback'];
};

export const classifyHybridResolverSpecifier = (
  specifier: string,
  {
    bundlerOwnedPrefixes = defaultBundlerOwnedSpecifierPrefixes,
  }: HybridResolverClassifierOptions = {}
): HybridResolverDecision => {
  if (bundlerOwnedPrefixes.some((prefix) => specifier.startsWith(prefix))) {
    return {
      reason: 'bundler-owned-prefix',
      route: 'bundler',
    };
  }

  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return {
      reason: 'ambiguous-specifier',
      route: 'bundler',
    };
  }

  if (/[?#]/.test(specifier)) {
    return {
      reason: 'query-or-hash',
      route: 'bundler',
    };
  }

  return {
    reason: 'safe-relative-specifier',
    route: 'oxc',
  };
};
