import type { EvalResolverMode } from '@wyw-in-js/shared';

export const getResolverPrecedence = (
  mode: EvalResolverMode
): readonly string[] => {
  if (mode === 'hybrid') {
    return ['customResolver', 'nativeResolver', 'bundlerResolver'];
  }

  if (mode === 'bundler') {
    return ['customResolver', 'bundlerResolver', 'nativeFallback'];
  }

  if (mode === 'custom') {
    return ['customResolver'];
  }

  return ['nativeResolver'];
};
