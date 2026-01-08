const transformMock = jest.fn();

let activeTransforms = 0;
let maxActiveTransforms = 0;

const createLogger = () => {
  const log = (() => {}) as any;
  log.extend = () => log;
  return log;
};

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  logger: createLogger(),
  slugify: () => 'slug',
  syncResolve: () => null,
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  getFileIdx: () => 'file',
  TransformCacheCollection: function TransformCacheCollection() {},
  transform: (...args: unknown[]) => transformMock(...args),
}));

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

describe('@wyw-in-js/rollup serializeTransform', () => {
  beforeEach(() => {
    transformMock.mockReset();
    activeTransforms = 0;
    maxActiveTransforms = 0;

    transformMock.mockImplementation(async () => {
      activeTransforms += 1;
      maxActiveTransforms = Math.max(maxActiveTransforms, activeTransforms);
      await sleep(25);
      activeTransforms -= 1;
      return {
        code: 'export const x = 1;',
        cssText: '.a{color:red}',
        sourceMap: null,
      };
    });
  });

  const createContext = () =>
    ({
      resolve: jest.fn(async (what: string) => ({ id: what, external: false })),
      warn: jest.fn(),
    }) as any;

  it('serializes concurrent transform() calls by default', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();
    const ctx = createContext();

    await Promise.all([
      plugin.transform!.call(ctx, 'export {}', '/abs/a.ts'),
      plugin.transform!.call(ctx, 'export {}', '/abs/b.ts'),
    ]);

    expect(maxActiveTransforms).toBe(1);
  });

  it('allows opting out', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });
    const ctx = createContext();

    await Promise.all([
      plugin.transform!.call(ctx, 'export {}', '/abs/a.ts'),
      plugin.transform!.call(ctx, 'export {}', '/abs/b.ts'),
    ]);

    expect(maxActiveTransforms).toBe(2);
  });
});
