import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
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

it('updates extracted CSS when an imported module changes (globalCache/watch)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-36-'));

  const entryFile = path.join(root, 'main.ts');
  const tokensFile = path.join(root, 'tokens.ts');
  const processorFile = path.resolve(
    __dirname,
    '__fixtures__',
    'test-css-processor.js'
  );

  fs.writeFileSync(
    tokensFile,
    dedent`
      export const colors = (() => ({
        blue: 'blue',
      }))();
    `
  );

  fs.writeFileSync(
    entryFile,
    dedent`
      import { css } from 'test-css-processor';
      import { colors } from './tokens';

      export const className = css\`
        color: \${colors.blue};
      \`;

      export const _usage = [className];
    `
  );

  const cache = new TransformCacheCollection();

  const runEntrypoint = () =>
    transform(
      {
        cache,
        options: {
          filename: entryFile,
          root,
          pluginOptions: {
            configFile: false,
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

  const runDependency = () =>
    transform(
      {
        cache,
        options: {
          filename: tokensFile,
          root,
          pluginOptions: {
            configFile: false,
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
      fs.readFileSync(tokensFile, 'utf8'),
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

  const initial = await runEntrypoint();
  expect(initial.cssText).toContain('blue');

  fs.writeFileSync(
    tokensFile,
    dedent`
      export const colors = (() => ({
        blue: 'blue',
        red: 'red',
      }))();
    `
  );

  await runDependency();

  fs.writeFileSync(
    entryFile,
    dedent`
      import { css } from 'test-css-processor';
      import { colors } from './tokens';

      export const className = css\`
        color: \${colors.red};
      \`;

      export const _usage = [className];
    `
  );

  const updated = await runEntrypoint();
  expect(updated.cssText).toContain('red');
  expect(updated.cssText).not.toContain('blue');
});
