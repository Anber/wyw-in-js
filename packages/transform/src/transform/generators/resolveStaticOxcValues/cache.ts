/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { isAbsolute } from 'path';

import { oxcShaker } from '../../../shaker';
import { runOxcPreevalStage } from '../../../utils/oxcPreevalStage';
import { stripQueryAndHash } from '../../../utils/parseRequest';
import type { ITransformAction } from '../../types';
import { isEnvDisabled, parseProgram } from './environment';
import type {
  StaticExportCacheEntry,
  StaticExportResult,
  StaticFileAnalysis,
  StaticFileHashCacheEntry,
  StaticMetadataPreevalCacheEntry,
} from './types';
import { STATIC_EXPORT_MAX_NULL_ATTEMPTS } from './types';

export const staticFileAnalysisCaches = new WeakMap<
  object,
  Map<string, StaticFileAnalysis>
>();

export const staticFileHashCaches = new WeakMap<
  object,
  Map<string, StaticFileHashCacheEntry>
>();

export const staticExportResultCaches = new WeakMap<
  object,
  Map<string, StaticExportCacheEntry>
>();

export const staticMetadataPreevalCaches = new WeakMap<
  object,
  Map<string, StaticMetadataPreevalCacheEntry>
>();

export const hashStaticContent = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex');

export const getWeakCacheMap = <TValue>(
  caches: WeakMap<object, Map<string, TValue>>,
  key: object
): Map<string, TValue> => {
  let cache = caches.get(key);
  if (!cache) {
    cache = new Map();
    caches.set(key, cache);
  }

  return cache;
};

export const isStaticResolveCacheEnabled = (): boolean => {
  const envValue = process.env.WYW_STATIC_RESOLVE_CACHE?.trim().toLowerCase();
  if (envValue) {
    return !isEnvDisabled(envValue);
  }

  return true;
};

export const staticCachePrefix = (action: ITransformAction): string =>
  `${action.services.cache.getKeySalt() ?? ''}\0${
    action.services.options.root ?? ''
  }`;

export const staticFileAnalysisCache = (
  action: ITransformAction
): Map<string, StaticFileAnalysis> =>
  getWeakCacheMap(staticFileAnalysisCaches, action.services.cache);

export const staticFileHashCache = (
  action: ITransformAction
): Map<string, StaticFileHashCacheEntry> =>
  getWeakCacheMap(staticFileHashCaches, action.services.cache);

export const staticExportResultCache = (
  action: ITransformAction
): Map<string, StaticExportCacheEntry> =>
  getWeakCacheMap(staticExportResultCaches, action.services.cache);

export const staticMetadataPreevalCache = (
  action: ITransformAction
): Map<string, StaticMetadataPreevalCacheEntry> =>
  getWeakCacheMap(staticMetadataPreevalCaches, action.services.cache);

export const staticFileAnalysisCacheKey = (
  action: ITransformAction,
  filename: string,
  codeHash: string
): string => `${staticCachePrefix(action)}\0${filename}\0${codeHash}`;

export const staticExportCacheKey = (
  action: ITransformAction,
  filename: string,
  exportedName: string,
  codeHash: string
): string =>
  `${staticCachePrefix(action)}\0${filename}\0${exportedName}\0${codeHash}`;

export const staticMetadataPreevalCacheKey = (
  action: ITransformAction,
  filename: string,
  codeHash: string
): string => `${staticCachePrefix(action)}\0${filename}\0${codeHash}`;

export const getStaticFileContentHash = (
  action: ITransformAction,
  dependency: string
): string | null => {
  const filename = stripQueryAndHash(dependency);
  if (!isAbsolute(filename)) {
    return null;
  }

  let stat;
  try {
    stat = statSync(filename);
  } catch {
    return null;
  }

  if (!stat.isFile()) {
    return null;
  }

  const cache = staticFileHashCache(action);
  const cached = cache.get(filename);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.hash;
  }

  let hash: string;
  try {
    hash = hashStaticContent(readFileSync(filename));
  } catch {
    return null;
  }

  cache.set(filename, {
    hash,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });
  return hash;
};

export const collectStaticDependencyHashes = (
  action: ITransformAction,
  dependencies: string[]
): Map<string, string> | null => {
  const hashes = new Map<string, string>();
  for (const dependency of dependencies) {
    const hash = getStaticFileContentHash(action, dependency);
    if (!hash) {
      return null;
    }

    hashes.set(stripQueryAndHash(dependency), hash);
  }

  return hashes;
};

export const areStaticDependencyHashesCurrent = (
  action: ITransformAction,
  dependencyHashes: Map<string, string>
): boolean => {
  for (const [dependency, expectedHash] of dependencyHashes) {
    if (getStaticFileContentHash(action, dependency) !== expectedHash) {
      return false;
    }
  }

  return true;
};

export const getStaticExportCachedResult = (
  action: ITransformAction,
  filename: string,
  exportedName: string,
  codeHash: string
): StaticExportResult | null | undefined => {
  if (!isStaticResolveCacheEnabled()) {
    return undefined;
  }

  const cache = staticExportResultCache(action);
  const cacheKey = staticExportCacheKey(
    action,
    filename,
    exportedName,
    codeHash
  );
  const cached = cache.get(cacheKey);
  if (!cached) {
    return undefined;
  }

  if (cached.result === null) {
    // Bounded retry: until the attempt counter has been bumped enough times
    // that we accept the null as stable, treat it as a cache miss so the
    // caller re-walks. The counter is updated in setStaticExportCachedResult.
    if (cached.attempts < STATIC_EXPORT_MAX_NULL_ATTEMPTS) {
      return undefined;
    }
    return null;
  }

  if (areStaticDependencyHashesCurrent(action, cached.dependencyHashes)) {
    return cached.result;
  }

  cache.delete(cacheKey);
  return undefined;
};

export const setStaticExportCachedResult = (
  action: ITransformAction,
  filename: string,
  exportedName: string,
  codeHash: string,
  result: StaticExportResult | null
): void => {
  if (!isStaticResolveCacheEnabled()) {
    return;
  }

  const cache = staticExportResultCache(action);
  const cacheKey = staticExportCacheKey(
    action,
    filename,
    exportedName,
    codeHash
  );
  if (!result) {
    const existing = cache.get(cacheKey);
    const attempts =
      existing && existing.result === null ? existing.attempts + 1 : 1;
    cache.set(cacheKey, { attempts, result: null });
    return;
  }

  const dependencyHashes = collectStaticDependencyHashes(
    action,
    result.dependencies
  );
  if (!dependencyHashes) {
    return;
  }

  cache.set(cacheKey, {
    dependencyHashes,
    result,
  });
};

export const getStaticFileAnalysis = (
  action: ITransformAction,
  filename: string
): StaticFileAnalysis | null => {
  const loadedAndParsed = action.services.loadAndParseFn(
    action.services,
    filename,
    undefined,
    action.services.log
  );
  if (
    loadedAndParsed.evaluator === 'ignored' ||
    loadedAndParsed.evaluator !== oxcShaker
  ) {
    return null;
  }

  const { code } = loadedAndParsed;
  const codeHash = hashStaticContent(code);
  const cache = staticFileAnalysisCache(action);
  const cacheKey = staticFileAnalysisCacheKey(action, filename, codeHash);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const analysis = {
    code,
    codeHash,
    program: parseProgram(code, filename),
  };
  cache.set(cacheKey, analysis);
  return analysis;
};

export const getStaticMetadataPreevalResult = (
  action: ITransformAction,
  filename: string,
  code: string,
  codeHash: string
): ReturnType<typeof runOxcPreevalStage> | null => {
  const cache = staticMetadataPreevalCache(action);
  const cacheKey = staticMetadataPreevalCacheKey(action, filename, codeHash);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached.result;
  }

  const root = action.services.options.root ?? process.cwd();
  try {
    const result = action.services.eventEmitter.perf(
      'transform:preeval:staticMetadata',
      () =>
        runOxcPreevalStage(
          code,
          {
            filename,
            root,
          },
          {
            ...action.services.options.pluginOptions,
            eventEmitter: action.services.eventEmitter,
          }
        )
    );
    cache.set(cacheKey, { result });
    return result;
  } catch {
    cache.set(cacheKey, { result: null });
    return null;
  }
};
