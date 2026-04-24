import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

import { BaseProcessor } from '@wyw-in-js/processor-utils';
import type { TagSource } from '@wyw-in-js/processor-utils';
import { findPackageJSON, syncResolve } from '@wyw-in-js/shared';
import type { StrictOptions, TagResolverMeta } from '@wyw-in-js/shared';

const nodeRequire = createRequire(import.meta.url);

export type ProcessorClass = new (
  ...args: ConstructorParameters<typeof BaseProcessor>
) => BaseProcessor;

const definedTagsCache = new Map<string, Record<string, string> | undefined>();
const resolvedTagResolverSourceCache = new Map<string, string | undefined>();
const packageProcessorLookupCache = new Map<string, ProcessorClass | null>();
const tagResolverProcessorLookupCache = new WeakMap<
  NonNullable<StrictOptions['tagResolver']>,
  Map<string, ProcessorClass | null>
>();

const createTagResolverLookupCacheKey = (
  source: string,
  imported: string,
  filename: string | null | undefined
): string => `${filename ?? ''}\0${source}\0${imported}`;

const createPackageLookupCacheKey = (
  source: string,
  imported: string
): string => `${source}\0${imported}`;

const getTagResolverLookupCache = (
  tagResolver: NonNullable<StrictOptions['tagResolver']>
): Map<string, ProcessorClass | null> => {
  const existing = tagResolverProcessorLookupCache.get(tagResolver);
  if (existing) {
    return existing;
  }

  const created = new Map<string, ProcessorClass | null>();
  tagResolverProcessorLookupCache.set(tagResolver, created);
  return created;
};

const getResolvedTagResolverSource = (
  source: string,
  sourceFile: string | null | undefined
): string | undefined => {
  if (!sourceFile) {
    return undefined;
  }

  const key = `${sourceFile}\0${source}`;
  if (resolvedTagResolverSourceCache.has(key)) {
    return resolvedTagResolverSourceCache.get(key);
  }

  try {
    const resolved = syncResolve(source, sourceFile, []);
    resolvedTagResolverSourceCache.set(key, resolved);
    return resolved;
  } catch {
    resolvedTagResolverSourceCache.set(key, undefined);
    return undefined;
  }
};

const getDefinedTagsFromPackage = (
  pkgName: string,
  filename: string | null | undefined
): Record<string, string> | undefined => {
  if (definedTagsCache.has(pkgName)) {
    return definedTagsCache.get(pkgName);
  }

  const packageJSONPath = findPackageJSON(pkgName, filename);
  if (!packageJSONPath) {
    return undefined;
  }

  const packageDir = dirname(packageJSONPath);
  const packageJSON = JSON.parse(readFileSync(packageJSONPath, 'utf8'));
  const definedTags: Record<string, string> | undefined =
    packageJSON['wyw-in-js']?.tags;

  const normalizedTags = definedTags
    ? Object.entries(definedTags).reduce(
        (acc, [key, value]) => ({
          ...acc,
          [key]: value.startsWith('.')
            ? join(packageDir, value)
            : nodeRequire.resolve(value, { paths: [packageDir] }),
        }),
        {} as Record<string, string>
      )
    : undefined;

  definedTagsCache.set(pkgName, normalizedTags);

  return normalizedTags;
};

const isValidProcessorClass = (module: unknown): module is ProcessorClass =>
  module instanceof BaseProcessor.constructor;

const getProcessorFromPackage = (
  packageName: string,
  tagName: string,
  filename: string | null | undefined
): ProcessorClass | null => {
  const definedTags = getDefinedTagsFromPackage(packageName, filename);
  const processorPath = definedTags?.[tagName];
  if (!processorPath) {
    return null;
  }

  const Processor = nodeRequire(processorPath).default;
  if (!isValidProcessorClass(Processor)) {
    return null;
  }

  return Processor;
};

const getProcessorFromFile = (processorPath: string): ProcessorClass | null => {
  const Processor = nodeRequire(processorPath).default;
  if (!isValidProcessorClass(Processor)) {
    return null;
  }

  return Processor;
};

export const getProcessorForImport = (
  { imported, source }: { imported: string; source: string },
  filename: string | null | undefined,
  options: Pick<StrictOptions, 'tagResolver'>
): [ProcessorClass | null, TagSource] => {
  const { tagResolver } = options;
  const cacheKey = tagResolver
    ? createTagResolverLookupCacheKey(source, imported, filename)
    : createPackageLookupCacheKey(source, imported);
  const lookupCache = tagResolver
    ? getTagResolverLookupCache(tagResolver)
    : packageProcessorLookupCache;

  if (lookupCache.has(cacheKey)) {
    return [lookupCache.get(cacheKey) ?? null, { imported, source }];
  }

  let customFile: string | null = null;
  if (tagResolver) {
    const tagResolverMeta: TagResolverMeta = {
      sourceFile: filename,
      resolvedSource: getResolvedTagResolverSource(source, filename),
    };

    customFile = tagResolver(source, imported, tagResolverMeta);
  }
  const processor = customFile
    ? getProcessorFromFile(customFile)
    : getProcessorFromPackage(source, imported, filename);
  lookupCache.set(cacheKey, processor);
  return [processor, { imported, source }];
};
