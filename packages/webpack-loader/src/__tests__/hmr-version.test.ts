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

describe('webpack-loader HMR CSS versioning', () => {
  beforeEach(() => {
    transformMock.mockReset();
  });

  it('adds a CSS version param to wyw query when hot', async () => {
    const { default: webpackLoader } = await import('../index');
    const resourcePath = '/abs/entry.jsx';

    const run = async (cssText: string, hot: boolean) => {
      transformMock.mockResolvedValueOnce({
        code: 'module.exports = 1;',
        sourceMap: null,
        cssText,
        cssSourceMapText: '',
        dependencies: [],
      });

      let emittedRequest = '';

      await new Promise<void>((resolve, reject) => {
        webpackLoader.call(
          {
            hot,
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

              emittedRequest = JSON.parse(match[1].trim());
              resolve();
            },
            context: process.cwd(),
            emitWarning: jest.fn(),
            getDependencies: () => [],
            getOptions: () => ({}),
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

      return emittedRequest;
    };

    const hotReq1 = await run('.title{color:red}', true);
    const hotReq2 = await run('.title{color:blue}', true);
    const coldReq = await run('.title{color:green}', false);

    expect(hotReq1).toMatch(/[?&]v=/);
    expect(hotReq2).toMatch(/[?&]v=/);
    expect(hotReq1).not.toEqual(hotReq2);
    expect(coldReq).not.toMatch(/[?&]v=/);
  });
});
