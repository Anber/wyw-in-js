import path from 'path';

import wywInJS from '..';

const transformMock = jest.fn();

jest.mock('vite', () => ({
  __esModule: true,
  optimizeDeps: jest.fn(),
  createFilter: () => () => true,
}));

jest.mock('@wyw-in-js/transform', () => {
  return {
    __esModule: true,
    createTransformManifest: (metadata: unknown, context: unknown) => ({
      ...metadata,
      ...context,
      version: 1,
    }),
    createFileReporter: () => ({
      emitter: { single: jest.fn() },
      onDone: jest.fn(),
    }),
    getFileIdx: () => '1',
    stringifyTransformManifest: (manifest: unknown) =>
      JSON.stringify(manifest, null, 2),
    TransformCacheCollection: class TransformCacheCollection {},
    transform: (...args: unknown[]) => transformMock(...args),
  };
});

describe('vite HMR', () => {
  beforeEach(() => {
    transformMock.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('defers reloadModule for generated CSS until after transform()', async () => {
    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      sourceMap: null,
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
    });

    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');
    const expectedCssFilename = path
      .normalize(`${entryId.replace(/\.[jt]sx?$/, '')}.wyw-in-js.css`)
      .replace(/\\/g, path.posix.sep);

    const reloadModule = jest.fn();
    const getModuleById = jest
      .fn()
      .mockImplementation((id: string) => ({ id }));

    const plugin = wywInJS();
    plugin.configResolved?.({ root } as any);
    plugin.configureServer?.({
      moduleGraph: { getModuleById },
      reloadModule,
    } as any);

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    expect(reloadModule).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();

    expect(getModuleById).toHaveBeenCalledWith(expectedCssFilename);
    expect(reloadModule).toHaveBeenCalledTimes(1);
  });

  it('does not reload CSS when generated CSS is unchanged', async () => {
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');

    const reloadModule = jest.fn();
    const getModuleById = jest
      .fn()
      .mockImplementation((id: string) => ({ id }));

    const plugin = wywInJS();
    plugin.configResolved?.({ root } as any);
    plugin.configureServer?.({
      moduleGraph: { getModuleById },
      reloadModule,
    } as any);

    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      sourceMap: null,
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );
    jest.runOnlyPendingTimers();
    expect(reloadModule).toHaveBeenCalledTimes(1);

    reloadModule.mockClear();
    getModuleById.mockClear();

    transformMock.mockResolvedValue({
      code: 'export const x = 2;',
      sourceMap: null,
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
    });

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test2")',
      entryId
    );
    jest.runOnlyPendingTimers();

    expect(reloadModule).not.toHaveBeenCalled();
  });

  it('emits metadata sidecars during build when transform() returns metadata', async () => {
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');
    const emitFile = jest.fn();

    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
      metadata: {
        dependencies: [],
        processors: [
          {
            artifacts: [['meta', { className: 'entry_a' }]],
            className: 'entry_a',
            displayName: 'entry',
            start: { column: 0, line: 1 },
          },
        ],
        replacements: [],
        rules: {
          '.entry_a': {
            className: 'entry_a',
            cssText: 'color:red;',
            displayName: 'entry',
            start: { column: 0, line: 1 },
          },
        },
      },
      sourceMap: null,
    });

    const plugin = wywInJS({ outputMetadata: true });
    plugin.configResolved?.({ root } as any);

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    plugin.generateBundle?.call({ emitFile } as any, {} as any, {} as any);

    expect(emitFile).toHaveBeenCalledWith({
      fileName: 'src/entry.wyw-in-js.json',
      source: expect.stringContaining('"source": "src/entry.tsx"'),
      type: 'asset',
    });
    expect(emitFile).toHaveBeenCalledWith({
      fileName: 'src/entry.wyw-in-js.json',
      source: expect.stringContaining('"cssFile": "src/entry.wyw-in-js.css"'),
      type: 'asset',
    });
  });

  it('clears stale metadata sidecars when a file stops producing metadata', async () => {
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');
    const emitFile = jest.fn();

    const plugin = wywInJS({ outputMetadata: true });
    plugin.configResolved?.({ root } as any);

    transformMock.mockResolvedValueOnce({
      code: 'export const x = 1;',
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
      metadata: {
        dependencies: [],
        processors: [],
        replacements: [],
        rules: {},
      },
      sourceMap: null,
    });

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    transformMock.mockResolvedValueOnce({
      code: 'export const x = 2;',
      cssText: undefined,
      cssSourceMapText: null,
      dependencies: [],
      sourceMap: null,
    });

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    plugin.generateBundle?.call({ emitFile } as any, {} as any, {} as any);

    expect(emitFile).not.toHaveBeenCalled();
  });

  it('clears stale metadata sidecars between rebuilds when a file disappears from the graph', async () => {
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.tsx');
    const emitFile = jest.fn();

    const plugin = wywInJS({ outputMetadata: true });
    plugin.configResolved?.({ root } as any);

    plugin.buildStart?.call({} as any);

    transformMock.mockResolvedValueOnce({
      code: 'export const x = 1;',
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
      metadata: {
        dependencies: [],
        processors: [],
        replacements: [],
        rules: {},
      },
      sourceMap: null,
    });

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    plugin.generateBundle?.call({ emitFile } as any, {} as any, {} as any);

    expect(emitFile).toHaveBeenCalledTimes(1);

    emitFile.mockClear();

    plugin.buildStart?.call({} as any);
    plugin.generateBundle?.call({ emitFile } as any, {} as any, {} as any);

    expect(emitFile).not.toHaveBeenCalled();
  });

  it('uses safe metadata asset paths for sources outside Vite root', async () => {
    const root = path.join(path.sep, 'repo', 'app');
    const entryId = path.join(
      path.sep,
      'repo',
      'packages',
      'ui',
      'src',
      'entry.tsx'
    );
    const emitFile = jest.fn();

    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
      metadata: {
        dependencies: [],
        processors: [],
        replacements: [],
        rules: {},
      },
      sourceMap: null,
    });

    const plugin = wywInJS({ outputMetadata: true });
    plugin.configResolved?.({ root } as any);

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    plugin.generateBundle?.call({ emitFile } as any, {} as any, {} as any);

    expect(emitFile).toHaveBeenCalledWith({
      fileName:
        '_wyw-in-js/external/__up__/packages/ui/src/entry.wyw-in-js.json',
      source: expect.stringContaining(
        '"source": "../packages/ui/src/entry.tsx"'
      ),
      type: 'asset',
    });
    expect(emitFile).toHaveBeenCalledWith({
      fileName:
        '_wyw-in-js/external/__up__/packages/ui/src/entry.wyw-in-js.json',
      source: expect.stringContaining(
        '"cssFile": "../packages/ui/src/entry.wyw-in-js.css"'
      ),
      type: 'asset',
    });
  });

  it('normalizes metadata filenames for supported module extensions', async () => {
    const root = process.cwd();
    const entryId = path.join(root, 'src', 'entry.mts');
    const emitFile = jest.fn();

    transformMock.mockResolvedValue({
      code: 'export const x = 1;',
      cssText: '.a{color:red;}',
      cssSourceMapText: null,
      dependencies: [],
      metadata: {
        dependencies: [],
        processors: [],
        replacements: [],
        rules: {},
      },
      sourceMap: null,
    });

    const plugin = wywInJS({ outputMetadata: true });
    plugin.configResolved?.({ root } as any);

    await plugin.transform?.call(
      { resolve: jest.fn() } as any,
      'console.log("test")',
      entryId
    );

    plugin.generateBundle?.call({ emitFile } as any, {} as any, {} as any);

    expect(emitFile).toHaveBeenCalledWith({
      fileName: 'src/entry.wyw-in-js.json',
      source: expect.stringContaining('"source": "src/entry.mts"'),
      type: 'asset',
    });
    expect(emitFile).toHaveBeenCalledWith({
      fileName: 'src/entry.wyw-in-js.json',
      source: expect.stringContaining('"cssFile": "src/entry.wyw-in-js.css"'),
      type: 'asset',
    });
  });
});
