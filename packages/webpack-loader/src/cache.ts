export interface ICache {
  get: (key: string) => Promise<string>;
  getDependencies?: (key: string) => Promise<string[]>;
  set: (key: string, value: string) => Promise<void>;
  setDependencies?: (key: string, value: string[]) => Promise<void>;
}

let cacheProviderSeq = 0;
const cacheProviderIds = new WeakMap<ICache, string>();
const cacheProvidersById = new Map<string, ICache>();

export const registerCacheProvider = (cacheProvider: ICache): string => {
  const knownId = cacheProviderIds.get(cacheProvider);
  if (knownId) {
    return knownId;
  }

  cacheProviderSeq += 1;
  const id = `${cacheProviderSeq}`;
  cacheProviderIds.set(cacheProvider, id);
  cacheProvidersById.set(id, cacheProvider);
  return id;
};

// memory cache, which is the default cache implementation in WYW-in-JS

class MemoryCache implements ICache {
  private cache: Map<string, string> = new Map();

  private dependenciesCache: Map<string, string[]> = new Map();

  public get(key: string): Promise<string> {
    return Promise.resolve(this.cache.get(key) ?? '');
  }

  public getDependencies(key: string): Promise<string[]> {
    return Promise.resolve(this.dependenciesCache.get(key) ?? []);
  }

  public set(key: string, value: string): Promise<void> {
    this.cache.set(key, value);
    return Promise.resolve();
  }

  public setDependencies(key: string, value: string[]): Promise<void> {
    this.dependenciesCache.set(key, value);
    return Promise.resolve();
  }
}

export const memoryCache = new MemoryCache();

/**
 * return cache instance from `options.cacheProvider`
 * @param cacheProvider string | ICache | undefined
 * @returns ICache instance
 */
export const getCacheInstance = async (
  cacheProvider: string | ICache | undefined,
  cacheProviderId?: string | undefined
): Promise<ICache> => {
  if (cacheProviderId) {
    const cacheProviderInstance = cacheProvidersById.get(cacheProviderId);
    if (!cacheProviderInstance) {
      throw new Error(`Invalid cache provider id: ${cacheProviderId}`);
    }

    return cacheProviderInstance;
  }

  if (!cacheProvider) {
    return memoryCache;
  }
  if (typeof cacheProvider === 'string') {
    return require(cacheProvider);
  }
  if (
    typeof cacheProvider === 'object' &&
    'get' in cacheProvider &&
    'set' in cacheProvider
  ) {
    return cacheProvider;
  }
  throw new Error(`Invalid cache provider: ${cacheProvider}`);
};
