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

it('keeps root CSS extraction when the entrypoint is superseded during eval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-supersede-eval-'));
  const sharedFile = path.join(root, 'shared.ts');
  const entryFile = path.join(root, 'entry.ts');
  const tokensFile = path.join(root, 'tokens.ts');

  fs.writeFileSync(tokensFile, `export const colors = { red: 'red' };`);

  const sharedCode = dedent`
    import { css } from 'test-css-processor';
    import { colors } from './tokens';

    export const shared = css\`
      color: \${colors.red};
    \`;
  `;

  const entryCode = dedent`
    import { css } from 'test-css-processor';
    import { shared } from './shared';

    export const local = css\`
      \${shared}
    \`;
  `;

  fs.writeFileSync(sharedFile, sharedCode);
  fs.writeFileSync(entryFile, entryCode);

  const cache = new TransformCacheCollection();
  const started = createDeferred();
  const unblock = createDeferred();
  let blockedSharedTokens = false;

  const asyncResolve = async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorFile;
    }

    if (what.startsWith('.') || path.isAbsolute(what)) {
      const resolved = resolveWithExtensions(
        path.resolve(path.dirname(importer), what)
      );

      if (resolved) {
        if (
          !blockedSharedTokens &&
          importer === sharedFile &&
          resolved === tokensFile
        ) {
          blockedSharedTokens = true;
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

  const run = (filename: string, code: string) =>
    transform(
      {
        cache,
        options: {
          filename,
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
      code,
      asyncResolve
    );

  const sharedTransform = run(sharedFile, sharedCode);
  await started.promise;

  const entryTransform = run(entryFile, entryCode);
  unblock.resolve();

  try {
    const [sharedResult, entryResult] = await Promise.all([
      sharedTransform,
      entryTransform,
    ]);

    expect(sharedResult.cssText).toContain('color:red');
    expect(entryResult.cssText).toBeDefined();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
