import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, normalize } from 'path';

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
  asyncResolverFactory: (onResolve: any, mapper: any) => {
    const memoized = new WeakMap<any, any>();
    return (resolveFn: any) => {
      if (!memoized.has(resolveFn)) {
        memoized.set(
          resolveFn,
          (what: string, importer: string, stack: string[]) =>
            Promise.resolve(resolveFn(...mapper(what, importer, stack))).then(
              (resolved) => onResolve(resolved, what, importer, stack)
            )
        );
      }
      return memoized.get(resolveFn);
    };
  },
  logger: createLogger(),
  syncResolve: (...args: unknown[]) => syncResolveMock(...args),
}));

jest.mock('vite', () => ({
  __esModule: true,
  optimizeDeps: (...args: unknown[]) => optimizeDepsMock(...args),
  createFilter: () => () => true,
  loadEnv: jest.fn(() => ({})),
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

    const resolveFn = jest.fn().mockResolvedValue('/@react-refresh');
    plugin.configResolved({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => resolveFn,
    } as any);

    await plugin.transform?.call(
      { warn: jest.fn() } as any,
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
    const resolveFn = jest
      .fn()
      .mockResolvedValue(`${missingCacheEntry}?v=deadbeef`);

    syncResolveMock.mockReturnValue(fallbackPath);

    const plugin = wywInJS();
    plugin.configResolved({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
      cacheDir,
      createResolver: () => resolveFn,
    } as any);

    await plugin.transform?.call(
      { warn: jest.fn() } as any,
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
      const resolveFn = jest
        .fn()
        .mockResolvedValue(`${missingCacheEntry}?v=deadbeef`);

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
      plugin.configResolved({
        root: process.cwd(),
        mode: 'development',
        command: 'serve',
        base: '/',
        cacheDir,
        createResolver: () => resolveFn,
      } as any);
      plugin.configureServer?.({
        environments: { client: { depsOptimizer } },
      } as any);

      await plugin.transform?.call(
        { warn: jest.fn() } as any,
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

  it('resolves Vite /@fs ids to real file paths', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();

    const resolveFn = jest.fn().mockImplementation((id: string) => id);
    plugin.configResolved({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => resolveFn,
    } as any);

    const tempDir = mkdtempSync(join(tmpdir(), 'wyw-vite-fs-'));
    try {
      const filePath = join(tempDir, 'Flex.ts');
      writeFileSync(filePath, 'export const Flex = () => null;', 'utf8');

      const viteFsId = `/@fs/${filePath.replace(/\\/g, '/')}`;
      requestedId = viteFsId;

      await plugin.transform?.call(
        { warn: jest.fn() } as any,
        'console.log("test")',
        '/entry.tsx'
      );

      expect(syncResolveMock).not.toHaveBeenCalled();
      expect(asyncResolveResults).toContain(normalize(filePath));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reuses the same cache and resolver across different plugin contexts', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();
    const resolveFn = jest.fn().mockResolvedValue('/resolved.ts');

    plugin.configResolved({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
      createResolver: () => resolveFn,
    } as any);

    const transformModule = await import('@wyw-in-js/transform');
    const transformMock = transformModule.transform as unknown as jest.Mock;
    transformMock.mockClear();

    const ctxA = { warn: jest.fn() } as any;
    const ctxB = { warn: jest.fn() } as any;

    await plugin.transform?.call(ctxA, 'console.log("a")', '/entry.tsx');
    await plugin.transform?.call(ctxA, 'console.log("b")', '/entry.tsx');
    await plugin.transform?.call(ctxB, 'console.log("c")', '/entry.tsx');

    const cacheA1 = transformMock.mock.calls[0][0].cache;
    const cacheA2 = transformMock.mock.calls[1][0].cache;
    const cacheB = transformMock.mock.calls[2][0].cache;
    const resolverA1 = transformMock.mock.calls[0][2];
    const resolverA2 = transformMock.mock.calls[1][2];
    const resolverB = transformMock.mock.calls[2][2];

    expect(cacheA1).toBe(cacheA2);
    expect(cacheA1).toBe(cacheB);
    expect(resolverA1).toBe(resolverA2);
    expect(resolverA1).toBe(resolverB);
  });

  it('keeps resolver stable across repeated configResolved calls', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();

    const tempDir = mkdtempSync(join(tmpdir(), 'wyw-vite-resolver-'));
    try {
      const fileA = join(tempDir, 'a.ts');
      const fileB = join(tempDir, 'b.ts');
      writeFileSync(fileA, 'export {}', 'utf8');
      writeFileSync(fileB, 'export {}', 'utf8');

      const resolveFnA = jest.fn().mockResolvedValue(fileA);
      plugin.configResolved({
        root: process.cwd(),
        mode: 'development',
        command: 'serve',
        base: '/',
        createResolver: () => resolveFnA,
      } as any);

      const transformModule = await import('@wyw-in-js/transform');
      const transformMock = transformModule.transform as unknown as jest.Mock;
      transformMock.mockClear();

      requestedId = 'a';

      await plugin.transform?.call(
        { warn: jest.fn() } as any,
        'console.log("a")',
        '/entry.tsx'
      );

      const resolverA = transformMock.mock.calls[0][2];

      const resolveFnB = jest.fn().mockResolvedValue(fileB);
      plugin.configResolved({
        root: process.cwd(),
        mode: 'development',
        command: 'serve',
        base: '/',
        createResolver: () => resolveFnB,
      } as any);

      requestedId = 'b';

      await plugin.transform?.call(
        { warn: jest.fn() } as any,
        'console.log("b")',
        '/entry.tsx'
      );

      const resolverB = transformMock.mock.calls[1][2];

      expect(resolverA).toBe(resolverB);
      expect(asyncResolveResults).toContain(normalize(fileA));
      expect(asyncResolveResults).toContain(normalize(fileB));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
