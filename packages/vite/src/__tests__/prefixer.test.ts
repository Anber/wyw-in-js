import path from 'path';

const transformMock = jest.fn();

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
  syncResolve: jest.fn(),
}));

jest.mock('vite', () => ({
  __esModule: true,
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
  transform: (...args: unknown[]) => transformMock(...args),
}));

const getCssFilename = (id: string) =>
  path
    .normalize(`${id.replace(/\.[jt]sx?$/, '')}.wyw-in-js.css`)
    .replace(/\\/g, path.posix.sep);

describe('vite prefixer option', () => {
  beforeEach(() => {
    transformMock.mockReset();
    transformMock.mockResolvedValue({
      code: 'export {}',
      sourceMap: null,
      cssText: undefined,
      dependencies: [],
    });
  });

  it('uses prefixer by default (forwards prefixer to transform)', async () => {
    transformMock.mockImplementation(async (services: any) => {
      expect(services.options.prefixer).toBeUndefined();
      return {
        code: 'export {}',
        sourceMap: null,
        cssText: '.foo{display:-webkit-box;display:flex;}',
        dependencies: [],
      };
    });

    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();

    const root = '/project';
    const entryFile = '/project/src/main.js';
    const cssFilename = getCssFilename(entryFile);

    plugin.configResolved({
      root,
      mode: 'development',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);

    const result = await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'export {}',
      entryFile
    );

    expect(result?.code).toContain(cssFilename);
    expect(plugin.load?.(cssFilename)).toContain('-webkit-');
  });

  it('disables prefixer when prefixer is false', async () => {
    transformMock.mockImplementation(async (services: any) => {
      expect(services.options.prefixer).toBe(false);
      return {
        code: 'export {}',
        sourceMap: null,
        cssText: '.foo{display:flex;}',
        dependencies: [],
      };
    });

    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ prefixer: false });

    const root = '/project';
    const entryFile = '/project/src/main.js';
    const cssFilename = getCssFilename(entryFile);

    plugin.configResolved({
      root,
      mode: 'development',
      command: 'build',
      base: '/',
      createResolver: () => jest.fn().mockResolvedValue(undefined),
    } as any);

    const result = await plugin.transform?.call(
      { resolve: jest.fn(), warn: jest.fn() } as any,
      'export {}',
      entryFile
    );

    expect(result?.code).toContain(cssFilename);
    expect(plugin.load?.(cssFilename)).not.toContain('-webkit-');
  });
});
