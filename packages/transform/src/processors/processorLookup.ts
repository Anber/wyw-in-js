import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

import { BaseProcessor } from '@wyw-in-js/processor-utils';
import type { TagSource } from '@wyw-in-js/processor-utils';
import { findPackageJSON, syncResolve } from '@wyw-in-js/shared';
import type { StrictOptions, TagResolverMeta } from '@wyw-in-js/shared';

import type { ProcessorManifest } from './manifest';
import { resolveProcessorReference } from './manifest';

const nodeRequire = createRequire(import.meta.url);

export type ProcessorClass = new (
  ...args: ConstructorParameters<typeof BaseProcessor>
) => BaseProcessor;

const definedTagsCache = new Map<string, Record<string, string> | undefined>();
const resolvedTagResolverSourceCache = new Map<string, string | undefined>();
type ProcessorLookupValue = {
  manifest: ProcessorManifest | null;
  processor: ProcessorClass | null;
};
const packageProcessorLookupCache = new Map<string, ProcessorLookupValue>();
const tagResolverProcessorLookupCache = new WeakMap<
  NonNullable<StrictOptions['tagResolver']>,
  Map<string, ProcessorLookupValue>
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

const URL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:/;

const isPackageLookupCandidate = (source: string): boolean => {
  if (
    !source ||
    source.startsWith('.') ||
    source.startsWith('/') ||
    source.startsWith('\\') ||
    source.startsWith('\0') ||
    source.startsWith('@/') ||
    source.startsWith('~/') ||
    source.startsWith('#') ||
    source.includes('?') ||
    source.includes('#') ||
    URL_SCHEME_RE.test(source)
  ) {
    return false;
  }

  if (source.startsWith('@')) {
    const [scope, pkg] = source.split('/', 2);
    return scope.length > 1 && !!pkg;
  }

  return true;
};

const getTagResolverLookupCache = (
  tagResolver: NonNullable<StrictOptions['tagResolver']>
): Map<string, ProcessorLookupValue> => {
  const existing = tagResolverProcessorLookupCache.get(tagResolver);
  if (existing) {
    return existing;
  }

  const created = new Map<string, ProcessorLookupValue>();
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

const getProcessorFromFile = (processorPath: string): ProcessorLookupValue => {
  const { implementationPath, manifest } =
    resolveProcessorReference(processorPath);
  const Processor = nodeRequire(implementationPath).default;
  if (!isValidProcessorClass(Processor)) {
    return {
      manifest: null,
      processor: null,
    };
  }

  return {
    manifest,
    processor: Processor,
  };
};

const getProcessorFromPackage = (
  packageName: string,
  tagName: string,
  filename: string | null | undefined
): ProcessorLookupValue => {
  const definedTags = getDefinedTagsFromPackage(packageName, filename);
  const processorPath = definedTags?.[tagName];
  if (!processorPath) {
    return {
      manifest: null,
      processor: null,
    };
  }

  return getProcessorFromFile(processorPath);
};

export const getProcessorForImport = (
  { imported, source }: { imported: string; source: string },
  filename: string | null | undefined,
  options: Pick<StrictOptions, 'tagResolver'>
): [ProcessorClass | null, TagSource, ProcessorManifest | null] => {
  const { tagResolver } = options;
  const packageLookupCandidate = isPackageLookupCandidate(source);

  if (!tagResolver && !packageLookupCandidate) {
    return [null, { imported, source }, null];
  }

  const cacheKey = tagResolver
    ? createTagResolverLookupCacheKey(source, imported, filename)
    : createPackageLookupCacheKey(source, imported);
  const lookupCache = tagResolver
    ? getTagResolverLookupCache(tagResolver)
    : packageProcessorLookupCache;

  if (lookupCache.has(cacheKey)) {
    const cached = lookupCache.get(cacheKey);
    return [
      cached?.processor ?? null,
      { imported, source },
      cached?.manifest ?? null,
    ];
  }

  let customFile: string | null = null;
  if (tagResolver) {
    const tagResolverMeta: TagResolverMeta = {
      sourceFile: filename,
      resolvedSource: getResolvedTagResolverSource(source, filename),
    };

    customFile = tagResolver(source, imported, tagResolverMeta);
  }
  let lookupValue: ProcessorLookupValue = {
    manifest: null,
    processor: null,
  };
  if (customFile) {
    lookupValue = getProcessorFromFile(customFile);
  } else if (packageLookupCandidate) {
    lookupValue = getProcessorFromPackage(source, imported, filename);
  }

  lookupCache.set(cacheKey, lookupValue);
  return [lookupValue.processor, { imported, source }, lookupValue.manifest];
};
