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

function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const { code } = error as NodeJS.ErrnoException;
  return code === 'ENOENT' || code === 'ENOTDIR';
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

  private keySalt: string | null = null;

  private invalidatedFiles = new Map<string, number>();

  private consumedInvalidationVersions = new Map<string, number>();

  constructor(caches: Partial<ICaches<TEntrypoint>> = {}) {
    this.barrelManifests = caches.barrelManifests || new Map();
    this.entrypoints = caches.entrypoints || new Map();
    this.exports = caches.exports || new Map();
  }

  public setKeySalt(keySalt: string | null) {
    if (this.keySalt === keySalt) return;

    const prevKeySalt = this.keySalt;
    this.keySalt = keySalt;

    if (prevKeySalt === null && keySalt) {
      const migrate = <TValue>(cache: Map<string, TValue>) => {
        const entries = Array.from(cache.entries());
        cache.clear();
        entries.forEach(([key, value]) => {
          cache.set(this.getKey(key), value);
        });
      };

      migrate(this.barrelManifests);
      migrate(this.entrypoints);
      migrate(this.exports);
      migrate(this.barrelManifestDependencies);
      migrate(this.exportDependencies);
      return;
    }

    this.barrelManifests.clear();
    this.entrypoints.clear();
    this.exports.clear();
    this.clearCacheDependencies('all');
  }

  private getKey(key: string) {
    if (!this.keySalt) return key;
    return `${key}::${this.keySalt}`;
  }

  public add<
    TCache extends CacheNames,
    TValue extends MapValue<ICaches<TEntrypoint>[TCache]>,
  >(cacheName: TCache, key: string, value: TValue): void {
    const cache = this[cacheName] as Map<string, TValue>;
    const cacheKey = this.getKey(key);
    loggers[cacheName]('%s:add %s %f', getFileIdx(key), key, () => {
      if (value === undefined) {
        return cache.has(cacheKey) ? 'removed' : 'noop';
      }

      if (!cache.has(cacheKey)) {
        return 'added';
      }

      return cache.get(cacheKey) === value ? 'unchanged' : 'updated';
    });

    if (value === undefined) {
      cache.delete(cacheKey);
      this.contentHashes.delete(key);
      this.clearCacheDependencies(cacheName, key);
      return;
    }

    this.clearCacheDependencies(cacheName, key);
    cache.set(cacheKey, value);

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
    const res = cache.get(this.getKey(key));

    loggers[cacheName]('get', key, res === undefined ? 'miss' : 'hit');
    return res;
  }

  public has(cacheName: CacheNames, key: string): boolean {
    const cache = this[cacheName] as Map<string, unknown>;
    const res = cache.has(this.getKey(key));

    loggers[cacheName]('has', key, res);
    return res;
  }

  public invalidate(cacheName: CacheNames, key: string): void {
    const cache = this[cacheName] as Map<string, unknown>;
    const cacheKey = this.getKey(key);

    if (!cache.has(cacheKey)) {
      return;
    }

    loggers[cacheName]('invalidate', key);

    cache.delete(cacheKey);
    this.clearCacheDependencies(cacheName, key);
  }

  public invalidateForFile(filename: string) {
    cacheNames.forEach((cacheName) => {
      this.invalidate(cacheName, filename);
    });

    const key = stripQueryAndHash(filename);
    const version = this.invalidatedFiles.get(key) ?? 0;
    this.invalidatedFiles.set(key, version + 1);
  }

  public consumeInvalidation(filename: string) {
    const key = stripQueryAndHash(filename);
    const invalidationVersion = this.invalidatedFiles.get(key);

    if (invalidationVersion === undefined) {
      return false;
    }

    const consumedVersion =
      this.consumedInvalidationVersions.get(filename) ?? 0;
    if (consumedVersion >= invalidationVersion) {
      return false;
    }

    this.consumedInvalidationVersions.set(filename, invalidationVersion);
    return true;
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

    if (
      !visitedFiles.has(filename) &&
      (fileEntrypoint || this.hasCachedDependencies(filename))
    ) {
      visitedFiles.add(filename);
      const invalidateOnDependencyChange =
        fileEntrypoint?.invalidateOnDependencyChange;
      const dependenciesToCheck = this.getDependenciesToCheck(
        filename,
        fileEntrypoint
      );

      for (const [, dependency] of dependenciesToCheck) {
        const dependencyFilename = dependency.resolved;

        if (dependencyFilename) {
          const dependencyChanged = this.didDependencyChange(
            dependencyFilename,
            visitedFiles,
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

  private getDependenciesToCheck(
    filename: string,
    fileEntrypoint?: TEntrypoint
  ): Map<string, { resolved: string | null }> {
    const dependenciesToCheck = new Map<string, { resolved: string | null }>();

    for (const [key, dependency] of fileEntrypoint?.dependencies ?? []) {
      dependenciesToCheck.set(key, dependency);
    }

    for (const [key, dependency] of fileEntrypoint?.invalidationDependencies ??
      []) {
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

    return dependenciesToCheck;
  }

  private didDependencyChange(
    dependencyFilename: string,
    visitedFiles: Set<string>,
    changedFiles: Set<string>
  ): boolean {
    if (changedFiles.has(dependencyFilename)) {
      return true;
    }

    if (visitedFiles.has(dependencyFilename)) {
      return false;
    }

    const strippedDependencyFilename = stripQueryAndHash(dependencyFilename);
    const cachedMtime = this.fileMtimes.get(dependencyFilename);
    const cachedEntrypoint = this.get('entrypoints', dependencyFilename);

    if (cachedMtime !== undefined) {
      let currentMtime: number;

      try {
        currentMtime = fs.statSync(strippedDependencyFilename).mtimeMs;
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }

        this.invalidateForFile(dependencyFilename);
        changedFiles.add(dependencyFilename);
        return true;
      }

      if (currentMtime === cachedMtime) {
        const nestedDependencies = this.getDependenciesToCheck(
          dependencyFilename,
          cachedEntrypoint
        );

        // A cached file without a cached entrypoint was invalidated earlier.
        if (!cachedEntrypoint && nestedDependencies.size === 0) {
          return true;
        }

        if (nestedDependencies.size === 0) {
          return false;
        }

        const nextVisitedFiles = new Set(visitedFiles);
        nextVisitedFiles.add(dependencyFilename);

        for (const [, nestedDependency] of nestedDependencies) {
          if (
            nestedDependency.resolved &&
            this.didDependencyChange(
              nestedDependency.resolved,
              nextVisitedFiles,
              changedFiles
            )
          ) {
            this.invalidateForFile(dependencyFilename);
            changedFiles.add(dependencyFilename);
            return true;
          }
        }

        return false;
      }
    }

    let dependencyContent: string;

    try {
      dependencyContent = fs.readFileSync(strippedDependencyFilename, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      this.invalidateForFile(dependencyFilename);
      changedFiles.add(dependencyFilename);
      return true;
    }

    return this.invalidateIfChanged(
      dependencyFilename,
      dependencyContent,
      visitedFiles,
      'fs',
      changedFiles
    );
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
    const cacheKey = this.getKey(key);

    if (nextDependencies.size === 0) {
      cache.delete(cacheKey);
      return;
    }

    cache.set(cacheKey, nextDependencies);
  }

  /**
   * Fast check if a file changed on disk since last seen.
   * Uses mtime as a fast path and only reads the file if mtime differs.
   */
  public checkFreshness(filename: string, strippedFilename: string): boolean {
    try {
      const currentMtime = fs.statSync(strippedFilename).mtimeMs;
      const cachedMtime = this.fileMtimes.get(filename);

      if (cachedMtime !== undefined && currentMtime === cachedMtime) {
        return false;
      }

      const content = fs.readFileSync(strippedFilename, 'utf8');
      this.fileMtimes.set(filename, currentMtime);

      if (this.invalidateIfChanged(filename, content, undefined, 'fs')) {
        return true;
      }

      return false;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      this.invalidateForFile(filename);
      return true;
    }
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
        this.barrelManifestDependencies.delete(this.getKey(key));
      }
      return;
    }

    if (cacheName === 'exports') {
      if (key === undefined) {
        this.exportDependencies.clear();
      } else {
        this.exportDependencies.delete(this.getKey(key));
      }
    }
  }

  private getCachedDependencies(filename: string): Set<string> {
    const key = this.getKey(filename);

    return new Set([
      ...(this.barrelManifestDependencies.get(key) ?? []),
      ...(this.exportDependencies.get(key) ?? []),
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
