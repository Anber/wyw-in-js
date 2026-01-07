const transformMock = jest.fn();

jest.mock('@wyw-in-js/shared', () => ({
  __esModule: true,
  logger: jest.fn(),
}));

jest.mock('@wyw-in-js/transform', () => ({
  __esModule: true,
  createFileReporter: () => ({
    emitter: { single: jest.fn() },
    onDone: jest.fn(),
  }),
  TransformCacheCollection: function TransformCacheCollection() {},
  transform: (...args: unknown[]) => transformMock(...args),
}));

class TestCache {
  cache = new Map<string, string>();

  dependenciesCache = new Map<string, string[]>();

  get(key: string) {
    return Promise.resolve(this.cache.get(key) ?? '');
  }

  getDependencies(key: string) {
    return Promise.resolve(this.dependenciesCache.get(key) ?? []);
  }

  set(key: string, value: string) {
    this.cache.set(key, value);
    return Promise.resolve();
  }

  setDependencies(key: string, value: string[]) {
    this.dependenciesCache.set(key, value);
    return Promise.resolve();
  }
}

describe('webpack-loader cacheProvider', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('passes object cacheProvider via cacheProviderId so outputCssLoader reads from same instance', async () => {
    const cacheProvider = new TestCache();

    transformMock.mockResolvedValue({
      code: 'module.exports = 1;',
      sourceMap: null,
      cssText: '.title{color:red}',
      cssSourceMapText: '',
      dependencies: [],
    });

    const { default: webpackLoader } = await import('../index');
    const { default: outputCssLoader } = await import('../outputCssLoader');

    const resourcePath = '/abs/entry.jsx';
    let emittedRequest = '';

    await new Promise<void>((resolve, reject) => {
      webpackLoader.call(
        {
          addDependency: jest.fn(),
          async: jest.fn(),
          callback: (err: Error | null, code?: string) => {
            if (err) {
              reject(err);
              return;
            }

            const match = String(code).match(/require\(([^)]+)\);/);
            if (!match) {
              reject(new Error('Expected loader to emit a require() call'));
              return;
            }

            emittedRequest = match[1].trim();

            resolve();
          },
          context: process.cwd(),
          emitWarning: jest.fn(),
          getDependencies: () => [],
          getOptions: () => ({ cacheProvider }),
          getResolve: () =>
            jest.fn(
              (
                _ctx: string,
                _token: string,
                cb: (err: any, res: any) => void
              ) => cb(null, null)
            ),
          resourcePath,
          rootContext: process.cwd(),
          utils: {
            contextify: (_ctx: string, request: string) => request,
          },
        } as any,
        'module.exports = 1;',
        null
      );
    });

    const request = JSON.parse(emittedRequest);
    const query = request.split('?', 2)[1].split('!', 1)[0];
    const params = new URLSearchParams(query);
    const cacheProviderId = params.get('cacheProviderId');

    expect(cacheProviderId).toBeTruthy();

    await new Promise<void>((resolve, reject) => {
      outputCssLoader.call({
        addDependency: jest.fn(),
        async: jest.fn(),
        callback: (err: Error | null, css?: string) => {
          if (err) {
            reject(err);
            return;
          }

          expect(css).toContain('.title{color:red}');
          resolve();
        },
        getOptions: () => ({
          cacheProvider: params.get('cacheProvider') || undefined,
          cacheProviderId: cacheProviderId ?? undefined,
        }),
        resourcePath,
      } as any);
    });
  });
});
