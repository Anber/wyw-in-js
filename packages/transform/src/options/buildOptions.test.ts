describe('buildOptions', () => {
  it('does not crash when @babel/core resolvePreset returns an object (Babel 7.25.7 regression)', async () => {
    const { buildOptions } = await import('./buildOptions');

    expect(() =>
      buildOptions({
        presets: ['@babel/preset-typescript', '@babel/preset-react'],
      })
    ).not.toThrow();
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
