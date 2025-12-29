describe('buildOptions', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('does not crash when @babel/core resolvePreset returns an object (Babel 7.25.7 regression)', () => {
    jest.doMock('@babel/core', () => ({
      resolvePlugin: (name: unknown) => {
        if (typeof name !== 'string') {
          throw new TypeError(
            'The "path" argument must be of type string. Received an instance of Object'
          );
        }

        return { filepath: `/abs/${name}` };
      },
      resolvePreset: (name: unknown) => {
        if (typeof name !== 'string') {
          throw new TypeError(
            'The "path" argument must be of type string. Received an instance of Object'
          );
        }

        return { filepath: `/abs/${name}` };
      },
    }));

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { buildOptions } = require('./buildOptions') as {
        buildOptions: (...configs: unknown[]) => unknown;
      };

      expect(() =>
        buildOptions({
          presets: ['@babel/preset-typescript', '@babel/preset-react'],
        })
      ).not.toThrow();
    });
  });

  it('merges configs deeply and preserves presets/plugins arrays', async () => {
    const { buildOptions } = await import('./buildOptions');

    expect(
      buildOptions(
        {
          assumptions: { setPublicClassFields: true },
          parserOpts: { plugins: ['typescript'] },
          presets: ['preset-a'],
        },
        {
          assumptions: { setPublicClassFields: false },
          parserOpts: { plugins: ['jsx'] },
          presets: ['preset-b'],
        }
      )
    ).toEqual({
      assumptions: { setPublicClassFields: false },
      parserOpts: { plugins: ['typescript', 'jsx'] },
      presets: ['preset-a', 'preset-b'],
    });
  });
});
