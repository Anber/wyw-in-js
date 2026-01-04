import fs from 'fs';
import path from 'path';

import { TransformCacheCollection } from '../cache';
import { transformSync } from '../transform';

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

it('keeps shared module initializers stable across multiple export requests', () => {
  const fixturesRoot = path.resolve(__dirname, '__fixtures__', 'issue-99');
  const preloadFile = path.join(fixturesRoot, 'preload.ts');
  const entryFile = path.join(fixturesRoot, 'main.ts');
  const processorFile = path.resolve(
    __dirname,
    '__fixtures__',
    'test-css-processor.js'
  );

  const preloadCode = fs.readFileSync(preloadFile, 'utf8');
  const code = fs.readFileSync(entryFile, 'utf8');

  const cache = new TransformCacheCollection();

  transformSync(
    {
      cache,
      options: {
        filename: preloadFile,
        root: fixturesRoot,
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
    preloadCode,
    (what, importer) => {
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

  const result = transformSync(
    {
      cache,
      options: {
        filename: entryFile,
        root: fixturesRoot,
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
    code,
    (what, importer) => {
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

  expect(result.cssText).toContain('green');
  expect(result.cssText).not.toContain('red');
});
