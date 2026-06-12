import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { transform } from '../transform';

const resolveWithExtensions = (candidate: string) => {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs'];
  for (const ext of extensions) {
    const withExt = `${candidate}${ext}`;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  return null;
};

it('supports Vite-style import.meta.env.* during build-time evaluation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-import-meta-env-'));
  const entryFile = path.join(root, 'main.ts');
  const processorFile = path.resolve(
    __dirname,
    '__fixtures__',
    'test-css-processor.js'
  );

  fs.writeFileSync(
    entryFile,
    dedent`
      import { css } from 'test-css-processor';

      const { MODE } = import.meta.env;

      export const className = css\`
        content: \${MODE};
        color: \${import.meta.env.DEV ? 'red' : 'blue'};
      \`;

      export const _usage = [className];
    `
  );

  const result = await transform(
    {
      options: {
        filename: entryFile,
        root,
        pluginOptions: {
          configFile: false,
          overrideContext: (context) => ({
            ...context,
            __wyw_import_meta_env: {
              MODE: 'development',
              DEV: true,
            },
          }),
          tagResolver: (source, tag) => {
            if (source === 'test-css-processor' && tag === 'css') {
              return processorFile;
            }

            return null;
          },
          babelOptions: {
            babelrc: false,
            configFile: false,
            presets: [
              ['@babel/preset-env', { loose: true }],
              '@babel/preset-react',
              '@babel/preset-typescript',
            ],
          },
        },
      },
    },
    fs.readFileSync(entryFile, 'utf8'),
    async (what, importer) => {
      if (what === 'test-css-processor') {
        return processorFile;
      }

      if (what.startsWith('.') || path.isAbsolute(what)) {
        const resolved = resolveWithExtensions(
          path.resolve(path.dirname(importer), what)
        );
        if (resolved) {
          return resolved;
        }
      }

      throw new Error(`Unable to resolve ${JSON.stringify(what)}`);
    }
  );

  expect(result.cssText).toContain('development');
  expect(result.cssText).toContain('red');
  expect(result.cssText).not.toContain('blue');
});
