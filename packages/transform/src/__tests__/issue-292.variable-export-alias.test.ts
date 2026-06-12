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

it('does not evaluate dead export property chains that reference aliases', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-292-'));
  const entryFile = path.join(root, 'main.ts');
  const processorFile = path.resolve(
    __dirname,
    '__fixtures__',
    'test-css-processor.js'
  );

  try {
    fs.writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';

        const CompA = () => {};
        CompA.dark = css\`color: #321;\`;
        export const DefaultComp = CompA;

        export const Mono = () => {};
        Mono.dark = DefaultComp.dark;

        export const Duo = () => {};
        Duo.dark = Mono.dark;
      `
    );

    const result = await transform(
      {
        cache: new TransformCacheCollection(),
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

        return null;
      }
    );

    expect(result.cssText).toContain('color:#321');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
