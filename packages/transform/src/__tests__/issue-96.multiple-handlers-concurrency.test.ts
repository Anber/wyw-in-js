import fs from 'fs';
import os from 'os';
import path from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';

const processorFile = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  return { promise, resolve };
};

describe('issue #96: actions must not run with multiple handlers', () => {
  it('allows concurrent transforms when asyncResolve is stable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-96-'));
    const entryFile = path.join(root, 'main.ts');
    const tokensFile = path.join(root, 'tokens.ts');

    const code = dedent`
      import { css } from 'test-css-processor';
      import { colors } from './tokens';

      export const className = css\`
        color: \${colors.red};
      \`;

      export const _usage = [className];
    `;

    const cache = new TransformCacheCollection();

    const started = createDeferred();
    const unblock = createDeferred();

    fs.writeFileSync(tokensFile, `export const colors = { red: 'red' };`);

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

    const asyncResolve = async (what: string, importer: string) => {
      if (what === 'test-css-processor') {
        return processorFile;
      }

      if (what.startsWith('.') || path.isAbsolute(what)) {
        const resolved = resolveWithExtensions(
          path.resolve(path.dirname(importer), what)
        );
        if (resolved) {
          if (resolved === tokensFile) {
            started.resolve();
            await unblock.promise;
          }
          return resolved;
        }
      }

      throw new Error(
        `Unexpected resolve ${JSON.stringify(what)} from ${importer}`
      );
    };

    const run = () =>
      transform(
        {
          cache,
          options: {
            filename: entryFile,
            root,
            pluginOptions: {
              configFile: false,
              evaluate: true,
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
        asyncResolve
      );

    const first = run();
    await started.promise;

    const second = run();

    unblock.resolve();

    try {
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.cssText).toContain('color:red');
      expect(secondResult.cssText).toContain('color:red');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
