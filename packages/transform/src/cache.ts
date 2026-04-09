import { createHash } from 'crypto';
import fs from 'node:fs';
import { logger } from '@wyw-in-js/shared';

import type { BarrelManifestCacheEntry } from './transform/barrelManifest';
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
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<string, { resolved: string | null }>;
}

interface ICaches<TEntrypoint extends IBaseCachedEntrypoint> {
  barrelManifests: Map<string, BarrelManifestCacheEntry>;
  entrypoints: Map<string, TEntrypoint>;
  exports: Map<string, string[]>;
}

type MapValue<T> = T extends Map<string, infer V> ? V : never;

const cacheLogger = logger.extend('cache');

const cacheNames = ['barrelManifests', 'entrypoints', 'exports'] as const;
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
  public readonly barrelManifests: Map<string, BarrelManifestCacheEntry>;

  public readonly entrypoints: Map<string, TEntrypoint>;

  public readonly exports: Map<string, string[]>;

  private readonly barrelManifestDependencies = new Map<string, Set<string>>();

  private contentHashes = new Map<string, { fs?: string; loaded?: string }>();

  private fileMtimes = new Map<string, number>();

  private readonly exportDependencies = new Map<string, Set<string>>();

  constructor(caches: Partial<ICaches<TEntrypoint>> = {}) {
    this.barrelManifests = caches.barrelManifests || new Map();
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
      this.clearCacheDependencies(cacheName, key);
      return;
    }

    this.clearCacheDependencies(cacheName, key);
    cache.set(key, value);

    if ('initialCode' in value) {
      const maybeOriginalCode = (value as unknown as { originalCode?: unknown })
        .originalCode;
      const isLoaded = typeof value.initialCode === 'string';
      const source = isLoaded ? 'loaded' : 'fs';

      let resolvedCode: string | undefined;
      if (isLoaded) {
        resolvedCode = value.initialCode;
      } else if (typeof maybeOriginalCode === 'string') {
        resolvedCode = maybeOriginalCode;
      }

      if (resolvedCode !== undefined) {
        this.setContentHash(key, source, hashContent(resolvedCode));
        return;
      }

      try {
        const fileContent = fs.readFileSync(stripQueryAndHash(key), 'utf8');
        this.setContentHash(key, source, hashContent(fileContent));
      } catch {
        this.setContentHash(key, source, hashContent(''));
      }

      return;
    }

    if (cacheName === 'barrelManifests') {
      try {
        const fileContent = fs.readFileSync(stripQueryAndHash(key), 'utf8');
        this.setContentHash(key, 'fs', hashContent(fileContent));
      } catch {
        this.setContentHash(key, 'fs', hashContent(''));
      }
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
    this.clearCacheDependencies(cacheName);
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
    this.clearCacheDependencies(cacheName, key);
  }

  public invalidateForFile(filename: string) {
    cacheNames.forEach((cacheName) => {
      this.invalidate(cacheName, filename);
    });
  }

  public invalidateIfChanged(
    filename: string,
    content: string,
    previousVisitedFiles?: Set<string>,
    source: 'fs' | 'loaded' = 'loaded',
    changedFiles = new Set<string>()
  ) {
    if (changedFiles.has(filename)) {
      return true;
    }

    const visitedFiles = new Set(previousVisitedFiles);
    const fileEntrypoint = this.get('entrypoints', filename);
    let anyDepChanged = false;

    // We need to check all dependencies of the file
    // because they might have changed as well.
    if (
      !visitedFiles.has(filename) &&
      (fileEntrypoint || this.hasCachedDependencies(filename))
    ) {
      visitedFiles.add(filename);
      const invalidateOnDependencyChange =
        fileEntrypoint?.invalidateOnDependencyChange;

      const dependenciesToCheck = new Map<
        string,
        { resolved: string | null }
      >();

      for (const [key, dependency] of fileEntrypoint?.dependencies ?? []) {
        dependenciesToCheck.set(key, dependency);
      }

      for (const [
        key,
        dependency,
      ] of fileEntrypoint?.invalidationDependencies ?? []) {
        if (!dependenciesToCheck.has(key)) {
          dependenciesToCheck.set(key, dependency);
        }
      }

      for (const dependencyFilename of this.getCachedDependencies(filename)) {
        if (
          ![...dependenciesToCheck.values()].some(
            (dependency) => dependency.resolved === dependencyFilename
          )
        ) {
          dependenciesToCheck.set(dependencyFilename, {
            resolved: dependencyFilename,
          });
        }
      }

      for (const [, dependency] of dependenciesToCheck) {
        const dependencyFilename = dependency.resolved;

        if (dependencyFilename) {
          const dependencyContent = fs.readFileSync(
            stripQueryAndHash(dependencyFilename),
            'utf8'
          );
          const dependencyChanged = this.invalidateIfChanged(
            dependencyFilename,
            dependencyContent,
            visitedFiles,
            'fs',
            changedFiles
          );

          if (
            dependencyChanged &&
            invalidateOnDependencyChange?.has(dependencyFilename)
          ) {
            cacheLogger(
              'dependency affecting output has changed, invalidate all for %s',
              filename
            );
            this.invalidateForFile(filename);
            changedFiles.add(filename);

            return true;
          }

          if (dependencyChanged) {
            anyDepChanged = true;
          }
        }
      }
    }

    const existing = this.contentHashes.get(filename);
    const previousHash = existing?.[source];
    const newHash = hashContent(content);

    if (previousHash === undefined) {
      const otherSource = source === 'fs' ? 'loaded' : 'fs';
      const otherHash = existing?.[otherSource];

      if ((otherHash !== undefined && otherHash !== newHash) || anyDepChanged) {
        cacheLogger('content has changed, invalidate all for %s', filename);
        this.setContentHash(filename, source, newHash);
        this.invalidateForFile(filename);
        changedFiles.add(filename);

        return true;
      }

      this.setContentHash(filename, source, newHash);
      if (anyDepChanged) {
        this.invalidateForFile(filename);
        changedFiles.add(filename);
        return true;
      }
      return false;
    }

    if (previousHash !== newHash || anyDepChanged) {
      cacheLogger('content has changed, invalidate all for %s', filename);
      this.setContentHash(filename, source, newHash);
      this.invalidateForFile(filename);
      changedFiles.add(filename);

      return true;
    }

    return false;
  }

  public setCacheDependencies(
    cacheName: 'barrelManifests' | 'exports',
    key: string,
    dependencies: Iterable<string>
  ): void {
    const cache = this.getDependencyCache(cacheName);
    const nextDependencies = new Set(
      [...dependencies].filter((dependency) => dependency.length > 0)
    );

    if (nextDependencies.size === 0) {
      cache.delete(key);
      return;
    }

    cache.set(key, nextDependencies);
  }

  private clearCacheDependencies(cacheName: CacheNames | 'all', key?: string) {
    if (cacheName === 'all') {
      this.barrelManifestDependencies.clear();
      this.exportDependencies.clear();
      return;
    }

    if (cacheName === 'barrelManifests') {
      if (key === undefined) {
        this.barrelManifestDependencies.clear();
      } else {
        this.barrelManifestDependencies.delete(key);
      }
      return;
    }

    if (cacheName === 'exports') {
      if (key === undefined) {
        this.exportDependencies.clear();
      } else {
        this.exportDependencies.delete(key);
      }
    }
  }

  private getCachedDependencies(filename: string): Set<string> {
    return new Set([
      ...(this.barrelManifestDependencies.get(filename) ?? []),
      ...(this.exportDependencies.get(filename) ?? []),
    ]);
  }

  private getDependencyCache(cacheName: 'barrelManifests' | 'exports') {
    return cacheName === 'barrelManifests'
      ? this.barrelManifestDependencies
      : this.exportDependencies;
  }

  private hasCachedDependencies(filename: string): boolean {
    return this.getCachedDependencies(filename).size > 0;
  }

  /**
   * Fast check if a file changed on disk since last seen.
   * Uses mtime as a fast path — only reads the file if mtime differs.
   * Returns true if the file changed (cache was invalidated).
   */
  public checkFreshness(filename: string, strippedFilename: string): boolean {
    try {
      const currentMtime = fs.statSync(strippedFilename).mtimeMs;
      const cachedMtime = this.fileMtimes.get(filename);

      if (cachedMtime !== undefined && currentMtime === cachedMtime) {
        return false;
      }

      const content = fs.readFileSync(strippedFilename, 'utf-8');
      this.fileMtimes.set(filename, currentMtime);

      if (this.invalidateIfChanged(filename, content, undefined, 'fs')) {
        return true;
      }

      return false;
    } catch {
      this.invalidateForFile(filename);
      return true;
    }
  }

  private setContentHash(
    filename: string,
    source: 'fs' | 'loaded',
    hash: string
  ) {
    const current = this.contentHashes.get(filename);
    if (current) {
      current[source] = hash;
    } else {
      this.contentHashes.set(filename, { [source]: hash });
    }

    if (source === 'fs') {
      try {
        this.fileMtimes.set(
          filename,
          fs.statSync(stripQueryAndHash(filename)).mtimeMs
        );
      } catch {
        // ignore
      }
    }
  }
}
