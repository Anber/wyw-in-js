describe('loadAndParse', () => {
  it('does not read from filesystem for ignored extensions with ?query', async () => {
    const { loadAndParse } = await import('../transform/Entrypoint.helpers');
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
