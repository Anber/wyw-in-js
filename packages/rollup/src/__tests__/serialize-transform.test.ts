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
  asyncResolverFactory:
    (onResolve: any, mapper: any) =>
    (resolveFn: any) =>
    (what: any, importer: any, stack: any) =>
      Promise.resolve(resolveFn(...mapper(what, importer, stack))).then(
        (resolved) => onResolve(resolved, what, importer, stack)
      ),
  logger: createLogger(),
  slugify: () => 'slug',
  syncResolve: () => null,
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  getFileIdx: () => 'file',
  TransformCacheCollection: function TransformCacheCollection() {
    return {
      get: () => undefined,
    };
  },
  transform: (...args: unknown[]) => transformMock(...args),
  disposeEvalBroker: jest.fn(),
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

  it('binds Rollup plugin context when calling this.resolve', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });

    let resolvedByAsyncResolver: unknown;
    transformMock.mockImplementationOnce(
      async (_services, _code, asyncResolve) => {
        resolvedByAsyncResolver = await asyncResolve(
          '@/components/Centered/Centered.ts',
          '/abs/a.ts',
          []
        );

        return {
          code: _code,
          cssText: '',
          sourceMap: null,
        };
      }
    );

    const resolveMock = jest.fn(function rollupResolve() {
      // Rollup's resolve() may rely on internal state stored on `this`.
      // If WyW calls it as an unbound function, it will throw.
      // eslint-disable-next-line no-void
      void (this as any)._resolveSkipCalls;

      return Promise.resolve({
        id: '/resolved.ts',
        external: false,
      });
    });

    await plugin.transform!.call(
      { resolve: resolveMock, warn: jest.fn(), _resolveSkipCalls: 0 } as any,
      'console.log("test")',
      '/abs/a.ts'
    );

    expect(resolvedByAsyncResolver).toBe('/resolved.ts');
  });

  it('loads resolved dependency code through Rollup for transform dependencies', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS({ serializeTransform: false });

    let loadedByService: unknown;
    transformMock.mockImplementationOnce(
      async (services, _code, asyncResolve) => {
        const resolved = await asyncResolve('./dep', '/abs/entry.ts', []);
        loadedByService = await services.loadDependencyCode?.(
          resolved,
          '/abs/entry.ts',
          './dep'
        );

        return {
          code: _code,
          cssText: '',
          sourceMap: null,
        };
      }
    );

    const loadMock = jest.fn(async ({ id }: { id: string }) => ({
      id,
      code: 'export const color = "red";',
    }));

    await plugin.transform!.call(
      {
        resolve: jest.fn(async () => ({
          id: '/abs/dep.ts',
          external: false,
        })),
        load: loadMock,
        warn: jest.fn(),
      } as any,
      'console.log("test")',
      '/abs/entry.ts'
    );

    expect(loadMock).toHaveBeenCalledWith({ id: '/abs/dep.ts' });
    expect(loadedByService).toBe('export const color = "red";');
  });

  it('bypasses serialization for Rollup dependency loads triggered by the parent transform', async () => {
    const { default: wywInJS } = await import('../index');
    const plugin = wywInJS();
    const calls: string[] = [];
    const ctx: any = {
      resolve: jest.fn(async () => ({
        id: '/abs/dep.ts',
        external: false,
      })),
      warn: jest.fn(),
    };

    ctx.load = jest.fn(async ({ id }: { id: string }) => {
      await plugin.transform!.call(ctx, 'export const color = "red";', id);
      return {
        id,
        code: 'export const color = "red";',
      };
    });

    transformMock.mockImplementationOnce(
      async (services, _code, asyncResolve) => {
        calls.push('entry:start');
        const resolved = await asyncResolve('./dep', '/abs/entry.ts', []);
        await services.loadDependencyCode?.(resolved, '/abs/entry.ts', './dep');
        calls.push('entry:end');

        return {
          code: _code,
          cssText: '',
          sourceMap: null,
        };
      }
    );
    transformMock.mockImplementationOnce(async (_services, _code) => {
      calls.push('dependency');

      return {
        code: _code,
        cssText: '',
        sourceMap: null,
      };
    });

    await plugin.transform!.call(ctx, 'console.log("test")', '/abs/entry.ts');

    expect(calls).toEqual(['entry:start', 'dependency', 'entry:end']);
  });
});
