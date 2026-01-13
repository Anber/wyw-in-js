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

    plugin.configResolved({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
    } as any);

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
    plugin.configResolved({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
      cacheDir,
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
      plugin.configResolved({
        root: process.cwd(),
        mode: 'development',
        command: 'serve',
        base: '/',
        cacheDir,
      } as any);
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

  it('resolves Vite /@fs ids to real file paths', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();

    plugin.configResolved({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
    } as any);

    const tempDir = mkdtempSync(join(tmpdir(), 'wyw-vite-fs-'));
    try {
      const filePath = join(tempDir, 'Flex.ts');
      writeFileSync(filePath, 'export const Flex = () => null;', 'utf8');

      const viteFsId = `/@fs/${filePath.replace(/\\/g, '/')}`;
      requestedId = viteFsId;

      const resolveMock = jest.fn().mockResolvedValue({
        id: viteFsId,
        external: false,
      });

      await plugin.transform?.call(
        { resolve: resolveMock } as any,
        'console.log("test")',
        '/entry.tsx'
      );

      expect(syncResolveMock).not.toHaveBeenCalled();
      expect(asyncResolveResults).toContain(normalize(filePath));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not fall back to syncResolve for external resolved file ids', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();

    plugin.configResolved({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
    } as any);

    const tempDir = mkdtempSync(join(tmpdir(), 'wyw-vite-fs-external-'));
    try {
      const filePath = join(tempDir, 'Flex.ts');
      writeFileSync(filePath, 'export const Flex = () => null;', 'utf8');

      const viteFsId = `/@fs/${filePath.replace(/\\/g, '/')}`;
      requestedId = viteFsId;

      const resolveMock = jest.fn().mockResolvedValue({
        id: viteFsId,
        external: 'absolute',
      });

      await plugin.transform?.call(
        { resolve: resolveMock } as any,
        'console.log("test")',
        '/entry.tsx'
      );

      expect(syncResolveMock).not.toHaveBeenCalled();
      expect(asyncResolveResults).toContain(normalize(filePath));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to syncResolve for external bare specifiers', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();
    requestedId = 'react';

    const resolvedPath = join(__dirname, 'node_modules', 'react.js');
    syncResolveMock.mockReturnValue(resolvedPath);

    plugin.configResolved({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
    } as any);

    const resolveMock = jest.fn().mockResolvedValue({
      id: requestedId,
      external: true,
    });

    await plugin.transform?.call(
      { resolve: resolveMock } as any,
      'console.log("test")',
      '/entry.tsx'
    );

    expect(syncResolveMock).toHaveBeenCalledWith('react', '/entry.tsx', []);
    expect(asyncResolveResults).toContain(resolvedPath);
  });

  it('binds Vite plugin context when calling this.resolve', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();

    plugin.configResolved({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
    } as any);

    requestedId = '@/components/Centered/Centered.ts';

    const resolveMock = jest.fn(function viteResolve() {
      // Vite 8's resolve() relies on internal state stored on `this`.
      // If WyW calls it as an unbound function, it will throw.
      // eslint-disable-next-line no-void
      void (this as any)._resolveSkipCalls;

      return Promise.resolve({
        id: '/resolved.ts',
        external: false,
      });
    });

    await plugin.transform?.call(
      { resolve: resolveMock, _resolveSkipCalls: 0 } as any,
      'console.log("test")',
      '/entry.tsx'
    );

    expect(asyncResolveResults).toContain('/resolved.ts');
  });

  it('uses a separate TransformCacheCollection per plugin context', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();

    plugin.configResolved({
      root: process.cwd(),
      mode: 'development',
      command: 'serve',
      base: '/',
    } as any);

    const transformModule = await import('@wyw-in-js/transform');
    const transformMock = transformModule.transform as unknown as jest.Mock;
    transformMock.mockClear();

    const ctxA = {
      resolve: jest
        .fn()
        .mockResolvedValue({ id: requestedId, external: false }),
      warn: jest.fn(),
    } as any;
    const ctxB = {
      resolve: jest
        .fn()
        .mockResolvedValue({ id: requestedId, external: false }),
      warn: jest.fn(),
    } as any;

    await plugin.transform?.call(ctxA, 'console.log("a")', '/entry.tsx');
    await plugin.transform?.call(ctxA, 'console.log("b")', '/entry.tsx');
    await plugin.transform?.call(ctxB, 'console.log("c")', '/entry.tsx');

    const cacheA1 = transformMock.mock.calls[0][0].cache;
    const cacheA2 = transformMock.mock.calls[1][0].cache;
    const cacheB = transformMock.mock.calls[2][0].cache;

    expect(cacheA1).toBe(cacheA2);
    expect(cacheA1).not.toBe(cacheB);
  });
});
