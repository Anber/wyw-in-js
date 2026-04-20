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

  it('does not treat pnpm store paths as a single ".pnpm" package', async () => {
    const { buildOptions } = await import('./buildOptions');

    const typescriptPath =
      '/project/node_modules/.pnpm/@babel+plugin-transform-typescript@7.25.9/node_modules/@babel/plugin-transform-typescript/lib/index.js';
    const reactJsxPath =
      '/project/node_modules/.pnpm/@babel+plugin-transform-react-jsx@7.25.9/node_modules/@babel/plugin-transform-react-jsx/lib/index.js';

    const merged = buildOptions(
      {
        plugins: [[typescriptPath, { foo: true }]],
      },
      {
        plugins: [[reactJsxPath, { bar: true }]],
      }
    );

    expect(merged.plugins).toEqual([
      [typescriptPath, { foo: true }],
      [reactJsxPath, { bar: true }],
    ]);
  });

  it('still recognizes pnpm store paths as Babel plugin keys (Windows path)', async () => {
    const { buildOptions } = await import('./buildOptions');

    const typescriptWindowsPath =
      'C:\\project\\node_modules\\.pnpm\\@babel+plugin-transform-typescript@7.25.9\\node_modules\\@babel\\plugin-transform-typescript\\lib\\index.js';

    const merged = buildOptions(
      {
        plugins: [['@babel/plugin-transform-typescript', { foo: true }]],
      },
      {
        plugins: [[typescriptWindowsPath, { bar: true }]],
      }
    );

    expect(merged.plugins).toEqual([
      ['@babel/plugin-transform-typescript', { foo: true, bar: true }],
    ]);
  });

  it('extracts real package names from pnpm store paths', async () => {
    const { buildOptions } = await import('./buildOptions');

    const typescriptPath =
      '/project/node_modules/.pnpm/@babel+plugin-transform-typescript@7.25.9/node_modules/@babel/plugin-transform-typescript/lib/index.js';

    const merged = buildOptions(
      {
        plugins: [['@babel/plugin-transform-typescript', { foo: true }]],
      },
      {
        plugins: [[typescriptPath, { bar: true }]],
      }
    );

    expect(merged.plugins).toEqual([
      ['@babel/plugin-transform-typescript', { foo: true, bar: true }],
    ]);
  });

  it('extracts package names from node_modules paths', async () => {
    const { buildOptions } = await import('./buildOptions');

    const pluginPath = '/project/node_modules/my-plugin/lib/index.js';

    const merged = buildOptions(
      {
        plugins: [['my-plugin', { foo: true }]],
      },
      {
        plugins: [[pluginPath, { bar: true }]],
      }
    );

    expect(merged.plugins).toEqual([['my-plugin', { foo: true, bar: true }]]);
  });

  it('extracts the innermost package name from nested node_modules paths', async () => {
    const { buildOptions } = await import('./buildOptions');

    const pluginPath =
      '/project/node_modules/wrapper/node_modules/inner-plugin/lib/index.js';

    const merged = buildOptions(
      {
        plugins: [['inner-plugin', { foo: true }]],
      },
      {
        plugins: [[pluginPath, { bar: true }]],
      }
    );

    expect(merged.plugins).toEqual([
      ['inner-plugin', { foo: true, bar: true }],
    ]);
  });
});
