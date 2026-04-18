import fs from 'fs';
import os from 'os';
import path from 'path';

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

it('does not recurse into imported modules for __wywPreval-only files without metadata', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'wyw-no-metadata-imports-')
  );
  const entryFile = path.join(root, 'entry.ts');
  const childFile = path.join(root, 'child.ts');
  const processorFile = path.resolve(
    __dirname,
    '__fixtures__',
    'test-css-processor.js'
  );

  fs.writeFileSync(
    entryFile,
    ["import { klass } from './child';", 'export const use = [klass];'].join(
      '\n'
    )
  );
  fs.writeFileSync(
    childFile,
    [
      "import { css } from 'test-css-processor';",
      'export const klass = css`',
      '  color: red;',
      '`;',
    ].join('\n')
  );

  const asyncResolve = jest.fn(async (what: string, importer: string) => {
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
  });

  const result = await transform(
    {
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
    asyncResolve
  );

  expect(result.code).toBe(fs.readFileSync(entryFile, 'utf8'));
  expect(result.cssText).toBeUndefined();
  expect(asyncResolve).not.toHaveBeenCalledWith('./child', entryFile, [entryFile]);
});
