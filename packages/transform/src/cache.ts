import { createHash } from 'crypto';
import fs from 'node:fs';
import { logger } from '@wyw-in-js/shared';

import type { Entrypoint } from './transform/Entrypoint';
import type { IEvaluatedEntrypoint } from './transform/EvaluatedEntrypoint';
import { getFileIdx } from './utils/getFileIdx';
import { stripQueryAndHash } from './utils/parseRequest';

function hashContent(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

interface IBaseCachedEntrypoint {
  dependencies: Map<string, { resolved: string | null }>;
  initialCode?: string;
}

interface ICaches<TEntrypoint extends IBaseCachedEntrypoint> {
  entrypoints: Map<string, TEntrypoint>;
  exports: Map<string, string[]>;
}

type MapValue<T> = T extends Map<string, infer V> ? V : never;

const cacheLogger = logger.extend('cache');

const cacheNames = ['entrypoints', 'exports'] as const;
type CacheNames = (typeof cacheNames)[number];

const loggers = cacheNames.reduce(
  (acc, key) => ({
    ...acc,
    [key]: cacheLogger.extend(key),
  }),
  {} as Record<CacheNames, typeof logger>
);

export class TransformCacheCollection<
  TEntrypoint extends IBaseCachedEntrypoint = Entrypoint | IEvaluatedEntrypoint,
> {
  public readonly entrypoints: Map<string, TEntrypoint>;

  public readonly exports: Map<string, string[]>;

  private contentHashes = new Map<string, string>();

  constructor(caches: Partial<ICaches<TEntrypoint>> = {}) {
    this.entrypoints = caches.entrypoints || new Map();
    this.exports = caches.exports || new Map();
  }

  public add<
    TCache extends CacheNames,
    TValue extends MapValue<ICaches<TEntrypoint>[TCache]>,
  >(cacheName: TCache, key: string, value: TValue): void {
    const cache = this[cacheName] as Map<string, TValue>;
    loggers[cacheName]('%s:add %s %f', getFileIdx(key), key, () => {
      if (value === undefined) {
        return cache.has(key) ? 'removed' : 'noop';
      }

      if (!cache.has(key)) {
        return 'added';
      }

      return cache.get(key) === value ? 'unchanged' : 'updated';
    });

    if (value === undefined) {
      cache.delete(key);
      this.contentHashes.delete(key);
      return;
    }

    cache.set(key, value);

    if ('initialCode' in value) {
      this.contentHashes.set(key, hashContent(value.initialCode ?? ''));
    }
  }

  public clear(cacheName: CacheNames | 'all'): void {
    if (cacheName === 'all') {
      cacheNames.forEach((name) => {
        this.clear(name);
      });

      return;
    }

    loggers[cacheName]('clear');
    const cache = this[cacheName] as Map<string, unknown>;

    cache.clear();
  }

  public delete(cacheName: CacheNames, key: string): void {
    this.invalidate(cacheName, key);
  }

  public get<
    TCache extends CacheNames,
    TValue extends MapValue<ICaches<TEntrypoint>[TCache]>,
  >(cacheName: TCache, key: string): TValue | undefined {
    const cache = this[cacheName] as Map<string, TValue>;

    const res = cache.get(key);
    loggers[cacheName]('get', key, res === undefined ? 'miss' : 'hit');
    return res;
  }

  public has(cacheName: CacheNames, key: string): boolean {
    const cache = this[cacheName] as Map<string, unknown>;

    const res = cache.has(key);
    loggers[cacheName]('has', key, res);
    return res;
  }

  public invalidate(cacheName: CacheNames, key: string): void {
    const cache = this[cacheName] as Map<string, unknown>;
    if (!cache.has(key)) {
      return;
    }

    loggers[cacheName]('invalidate', key);

    cache.delete(key);
  }

  public invalidateForFile(filename: string) {
    cacheNames.forEach((cacheName) => {
      this.invalidate(cacheName, filename);
    });
  }

  public invalidateIfChanged(
    filename: string,
    content: string,
    previousVisitedFiles?: Set<string>
  ) {
    const visitedFiles = new Set(previousVisitedFiles);
    const fileEntrypoint = this.get('entrypoints', filename);

    // We need to check all dependencies of the file
    // because they might have changed as well.
    if (fileEntrypoint && !visitedFiles.has(filename)) {
      visitedFiles.add(filename);

      for (const [, dependency] of fileEntrypoint.dependencies) {
        const dependencyFilename = dependency.resolved;

        if (dependencyFilename) {
          const dependencyContent = fs.readFileSync(
            stripQueryAndHash(dependencyFilename),
            'utf8'
          );
          this.invalidateIfChanged(
            dependencyFilename,
            dependencyContent,
            visitedFiles
          );
        }
      }
    }

    const hash = this.contentHashes.get(filename);
    const newHash = hashContent(content);

    if (hash !== newHash) {
      cacheLogger('content has changed, invalidate all for %s', filename);
      this.contentHashes.set(filename, newHash);
      this.invalidateForFile(filename);

      return true;
    }

    return false;
  }
}
