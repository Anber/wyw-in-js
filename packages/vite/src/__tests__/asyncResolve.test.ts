import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const optimizeDepsMock = jest.fn();
const asyncResolveResults: Array<string | null> = [];
const syncResolveMock = jest.fn();

let requestedId = '/@react-refresh';
let requestedImporter = '/entry.tsx';

const createLogger = () => {
  const log = (() => undefined) as unknown as ((...args: unknown[]) => void) & {
    extend: (...args: unknown[]) => unknown;
  };

  log.extend = () => log;
  return log;
};

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  logger: createLogger(),
  syncResolve: (...args: unknown[]) => syncResolveMock(...args),
}));

jest.mock('vite', () => ({
  __esModule: true,
  optimizeDeps: (...args: unknown[]) => optimizeDepsMock(...args),
  createFilter: () => () => true,
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  getFileIdx: () => '1',
  TransformCacheCollection: class TransformCacheCollection {},
  transform: jest.fn(async (_services, _code, asyncResolve) => {
    const resolved = await asyncResolve(requestedId, requestedImporter, []);
    asyncResolveResults.push(resolved);
    return {
      code: _code,
      sourceMap: null,
      cssText: undefined,
      dependencies: [],
    };
  }),
}));

describe('vite asyncResolve', () => {
  beforeEach(() => {
    optimizeDepsMock.mockClear();
    syncResolveMock.mockClear();
    asyncResolveResults.length = 0;
    requestedId = '/@react-refresh';
    requestedImporter = '/entry.tsx';
  });

  it('ignores Vite virtual ids like /@react-refresh', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();

    plugin.configResolved({ root: process.cwd() } as any);

    const resolveMock = jest.fn().mockResolvedValue({
      id: '/@react-refresh',
      external: false,
    });

    await plugin.transform?.call(
      { resolve: resolveMock } as any,
      'console.log("test")',
      '/entry.tsx'
    );

    expect(optimizeDepsMock).not.toHaveBeenCalled();
    expect(asyncResolveResults).toContain(null);
  });

  it('falls back to syncResolve when Vite resolves to missing cache entry', async () => {
    const { default: wywInJS } = await import('../index');
    requestedId = 'react';
    const cacheDir = join(__dirname, '.vite-cache');
    const missingCacheEntry = join(cacheDir, 'deps', 'react.js');
    const fallbackPath = join(__dirname, 'node_modules', 'react.js');

    syncResolveMock.mockReturnValue(fallbackPath);

    const plugin = wywInJS();
    plugin.configResolved({ root: process.cwd(), cacheDir } as any);

    const resolveMock = jest.fn().mockResolvedValue({
      id: `${missingCacheEntry}?v=deadbeef`,
      external: false,
    });

    await plugin.transform?.call(
      { resolve: resolveMock } as any,
      'console.log("test")',
      '/entry.tsx'
    );

    expect(optimizeDepsMock).not.toHaveBeenCalled();
    expect(syncResolveMock).toHaveBeenCalledWith('react', '/entry.tsx', []);
    expect(asyncResolveResults).toContain(fallbackPath);
  });

  it('waits for depsOptimizer to finish processing optimized deps files', async () => {
    const { default: wywInJS } = await import('../index');
    requestedId = 'react';

    const cacheDir = mkdtempSync(join(tmpdir(), 'wyw-vite-cache-'));
    try {
      const missingCacheEntry = join(cacheDir, 'deps', 'react.js');

      const processing = new Promise<void>((resolve) => {
        setTimeout(() => {
          mkdirSync(join(cacheDir, 'deps'), { recursive: true });
          writeFileSync(missingCacheEntry, 'export default {};', 'utf8');
          resolve();
        }, 0);
      });

      const depsOptimizer = {
        init: jest.fn().mockResolvedValue(undefined),
        isOptimizedDepFile: jest.fn().mockReturnValue(true),
        scanProcessing: Promise.resolve(),
        metadata: {
          depInfoList: [{ file: missingCacheEntry, processing }],
        },
      };

      const plugin = wywInJS();
      plugin.configResolved({ root: process.cwd(), cacheDir } as any);
      plugin.configureServer?.({
        environments: { client: { depsOptimizer } },
      } as any);

      const resolveMock = jest.fn().mockResolvedValue({
        id: `${missingCacheEntry}?v=deadbeef`,
        external: false,
      });

      await plugin.transform?.call(
        { resolve: resolveMock } as any,
        'console.log("test")',
        '/entry.tsx'
      );

      expect(optimizeDepsMock).not.toHaveBeenCalled();
      expect(syncResolveMock).not.toHaveBeenCalled();
      expect(asyncResolveResults).toContain(missingCacheEntry);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
