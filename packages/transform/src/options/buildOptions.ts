import type { TransformOptions } from '@babel/core';

import { isNotNull } from '../utils/isNotNull';

const cache = new WeakMap<
  TransformOptions,
  WeakMap<TransformOptions, TransformOptions>
>();

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject => {
  if (typeof value !== 'object' || value === null) return false;

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

type ItemKind = 'plugin' | 'preset';

const mergeArraysUnique = <T>(source: T[] = [], overrides: T[] = []) => [
  ...new Set([...source, ...overrides]),
];

const mergeUnknown = (source: unknown, overrides: unknown): unknown => {
  if (Array.isArray(source) && Array.isArray(overrides)) {
    return mergeArraysUnique(source, overrides);
  }

  if (isPlainObject(source) && isPlainObject(overrides)) {
    const result: PlainObject = { ...source };

    for (const [key, value] of Object.entries(overrides)) {
      result[key] = key in source ? mergeUnknown(source[key], value) : value;
    }

    return result;
  }

  return overrides;
};

type PluginOrPresetItem = NonNullable<
  TransformOptions['plugins']
>[number] extends never
  ? unknown
  : NonNullable<TransformOptions['plugins']>[number];

const getItemKey = (item: unknown): string | null => {
  if (typeof item === 'string') return item;
  if (Array.isArray(item)) return getItemKey(item[0]);
  if (typeof item === 'object' && item !== null && 'key' in item) {
    const { key } = item as { key?: unknown };
    return typeof key === 'string' ? key : null;
  }

  return null;
};

const getItemOptions = (item: unknown): PlainObject => {
  if (!Array.isArray(item)) return {};
  const options = item[1];
  return isPlainObject(options) ? options : {};
};

const toItemWithOptions = (key: string, options: PlainObject) =>
  Object.keys(options).length ? ([key, options] as const) : key;

const normalizeKey = (key: string) => key.replace(/\\/g, '/');

const extractPackageNameFromPath = (key: string): string | null => {
  const normalized = normalizeKey(key);
  const token = '/node_modules/';

  let nodeModulesIndex = normalized.lastIndexOf(token);
  while (nodeModulesIndex !== -1) {
    const start = nodeModulesIndex + token.length;
    const firstChar = normalized[start];
    if (!firstChar) return null;

    let packageName: string | null = null;
    if (firstChar === '@') {
      const scopeEnd = normalized.indexOf('/', start);
      if (scopeEnd === -1) return null;
      const nameEnd = normalized.indexOf('/', scopeEnd + 1);
      if (nameEnd === -1) return null;
      packageName = normalized.slice(start, nameEnd);
    } else {
      const nameEnd = normalized.indexOf('/', start);
      if (nameEnd === -1) return null;
      packageName = normalized.slice(start, nameEnd);
    }

    if (!packageName.startsWith('.')) return packageName;

    nodeModulesIndex = normalized.lastIndexOf(token, nodeModulesIndex - 1);
  }

  return null;
};

const addBabelVariants = (
  kind: ItemKind,
  variants: Set<string>,
  key: string
) => {
  const prefix =
    kind === 'preset'
      ? ['@babel/preset-', 'babel-preset-']
      : ['@babel/plugin-', 'babel-plugin-'];

  const normalized = normalizeKey(key);
  variants.add(normalized);

  const packageNameFromPath = extractPackageNameFromPath(normalized);
  if (packageNameFromPath) {
    variants.add(packageNameFromPath);
  }

  for (const p of prefix) {
    if (normalized.startsWith(p)) {
      variants.add(normalized.slice(p.length));
    }
  }

  if (!normalized.includes('/') && !normalized.startsWith('.')) {
    variants.add(`${prefix[0]}${normalized}`);
    variants.add(`${prefix[1]}${normalized}`);
  }
};

const areKeysCompatible = (kind: ItemKind, a: string, b: string) => {
  const aVariants = new Set<string>();
  addBabelVariants(kind, aVariants, a);

  const bVariants = new Set<string>();
  addBabelVariants(kind, bVariants, b);

  for (const aVar of aVariants) {
    if (bVariants.has(aVar)) return true;
  }

  return false;
};

const mergeConfigItems = (
  kind: ItemKind,
  source: PluginOrPresetItem[] | null | undefined,
  overrides: PluginOrPresetItem[] | null | undefined
) => {
  const combined = [...(source ?? []), ...(overrides ?? [])];

  return combined.reduce<PluginOrPresetItem[]>((reduction, override) => {
    const overrideKey = getItemKey(override);
    if (!overrideKey) {
      reduction.push(override);
      return reduction;
    }

    const overrideOptions = getItemOptions(override);

    const base = reduction.find((candidate) => {
      const baseKey = getItemKey(candidate);
      return baseKey ? areKeysCompatible(kind, baseKey, overrideKey) : false;
    });

    if (!base) {
      reduction.push(
        toItemWithOptions(overrideKey, overrideOptions) as PluginOrPresetItem
      );
      return reduction;
    }

    const index = reduction.indexOf(base);
    const baseKey = getItemKey(base) ?? overrideKey;
    const baseOptions = getItemOptions(base);
    const options = mergeUnknown(baseOptions, overrideOptions) as PlainObject;

    reduction.splice(
      index,
      1,
      toItemWithOptions(baseKey, options) as PluginOrPresetItem
    );
    return reduction;
  }, []);
};

const babelMerge = (source: TransformOptions, overrides: TransformOptions) => {
  const {
    plugins: sourcePlugins,
    presets: sourcePresets,
    env: sourceEnv,
    ...sourceRest
  } = source;
  const {
    plugins: overridesPlugins,
    presets: overridesPresets,
    env: overridesEnv,
    ...overridesRest
  } = overrides;

  const plugins = mergeConfigItems('plugin', sourcePlugins, overridesPlugins);
  const presets = mergeConfigItems('preset', sourcePresets, overridesPresets);

  const merged: TransformOptions = mergeUnknown(
    sourceRest,
    overridesRest
  ) as TransformOptions;
  if (presets.length) merged.presets = presets;
  if (plugins.length) merged.plugins = plugins;

  const envNames = new Set([
    ...Object.keys(sourceEnv ?? {}),
    ...Object.keys(overridesEnv ?? {}),
  ]);

  if (envNames.size) {
    merged.env = {};
    for (const name of envNames) {
      merged.env[name] = babelMerge(
        sourceEnv?.[name] ?? {},
        overridesEnv?.[name] ?? {}
      );
    }
  }

  return merged;
};

const merge = (a: TransformOptions, b: TransformOptions) => {
  if (!cache.has(a)) {
    cache.set(a, new WeakMap());
  }

  const cacheForA = cache.get(a)!;
  if (cacheForA.has(b)) {
    return cacheForA.get(b)!;
  }

  const result = babelMerge(a, b);
  cacheForA.set(b, result);
  return result;
};

/**
 * Merges babel configs together. If a pair of configs were merged before,
 * it will return the cached result.
 */
export function buildOptions(
  ...configs: (TransformOptions | null | undefined)[]
): TransformOptions {
  // Merge all configs together
  return configs
    .map((i) => i ?? null)
    .filter(isNotNull)
    .reduce(merge);
}
