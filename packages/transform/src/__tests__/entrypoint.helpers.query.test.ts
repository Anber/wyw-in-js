describe('loadAndParse', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('does not read from filesystem for ignored extensions with ?query', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadAndParse } = require('../transform/Entrypoint.helpers') as {
      loadAndParse: (...args: unknown[]) => unknown;
    };

    const log = jest.fn();

    const res = loadAndParse(
      {
        babel: {},
        eventEmitter: {},
        options: {
          pluginOptions: {
            extensions: ['.js', '.ts', '.tsx'],
            rules: [],
          },
        },
      },
      '/abs/icon.svg?svgUse',
      undefined,
      log
    );

    expect(res).toMatchObject({
      evaluator: 'ignored',
      reason: 'extension',
    });

    expect(() => (res as any).code).not.toThrow();
    expect((res as any).code).toBeUndefined();
  });
});
