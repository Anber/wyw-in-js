import type { OxcOptions } from './types';

export type NativeResolverAlias = Record<
  string,
  Array<string | undefined | null>
>;

type AliasEntry = {
  alias?: unknown;
  find?: unknown;
  name?: unknown;
  replacement?: unknown;
};

const isNativeResolverAlias = (value: unknown): value is NativeResolverAlias =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toAliasTargets = (
  replacement: unknown
): Array<string | undefined | null> | null => {
  if (typeof replacement === 'string') {
    return [replacement];
  }

  if (
    Array.isArray(replacement) &&
    replacement.every((item) => typeof item === 'string')
  ) {
    return replacement;
  }

  return null;
};

export const toNativeResolverAlias = (
  alias: unknown
): NativeResolverAlias => {
  const nativeAlias: NativeResolverAlias = {};

  const entries = Array.isArray(alias)
    ? alias
    : isNativeResolverAlias(alias)
      ? Object.entries(alias).map(([find, replacement]) => ({
          find,
          replacement,
        }))
      : [];

  entries.forEach((rawEntry) => {
    if (!isNativeResolverAlias(rawEntry)) {
      return;
    }

    const entry = rawEntry as AliasEntry;
    const find = 'find' in entry ? entry.find : entry.name;
    const replacement =
      'replacement' in entry ? entry.replacement : entry.alias;
    const targets = toAliasTargets(replacement);

    if (typeof find !== 'string' || !targets) {
      return;
    }

    nativeAlias[find] = targets;
  });

  return nativeAlias;
};

export const mergeOxcResolverAlias = (
  oxcOptions: OxcOptions | undefined,
  bundlerAlias: NativeResolverAlias
): OxcOptions | undefined => {
  if (Object.keys(bundlerAlias).length === 0) {
    return oxcOptions;
  }

  const resolver = oxcOptions?.resolver ?? {};
  const configuredAlias = isNativeResolverAlias(resolver.alias)
    ? resolver.alias
    : {};

  return {
    ...oxcOptions,
    resolver: {
      ...resolver,
      alias: {
        ...bundlerAlias,
        ...configuredAlias,
      },
    },
  };
};
