import fs from 'fs';
import os from 'os';
import path from 'path';

import * as esbuild from 'esbuild';

import wywInJS from '../index';

const getJsText = (result: esbuild.BuildResult): string | null => {
  const js = result.outputFiles?.find((file) => file.path.endsWith('.js'));
  return js?.text ?? null;
};

const hasCssOutput = (result: esbuild.BuildResult): boolean =>
  Boolean(result.outputFiles?.some((file) => file.path.endsWith('.css')));

it('returns transformed JS even when cssText is empty', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esbuild-220-'));
  const outdir = path.join(root, 'dist');

  const entryFile = path.join(root, 'main.ts');

  const nmRoot = path.join(root, 'node_modules');
  const processorStubDir = path.join(nmRoot, 'test-css-processor');

  fs.mkdirSync(processorStubDir, { recursive: true });

  fs.writeFileSync(
    path.join(processorStubDir, 'package.json'),
    JSON.stringify({
      name: 'test-css-processor',
      version: '1.0.0',
      type: 'module',
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(processorStubDir, 'index.js'),
    `export const css = (strings) => strings.join('');\n`,
    'utf8'
  );

  fs.writeFileSync(
    entryFile,
    [
      `import { css } from 'test-css-processor';`,
      ``,
      `const className = css\`color: red;\`;`,
      ``,
      `// intentionally unused`,
      ``,
    ].join('\n'),
    'utf8'
  );

  const processorFile = path.resolve(
    __dirname,
    '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
  );

  const cwd = process.cwd();
  process.chdir(root);

  try {
    const result = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      format: 'esm',
      write: false,
      outdir,
      plugins: [
        wywInJS({
          configFile: false,
          tagResolver: (source: string, tag: string) => {
            if (source === 'test-css-processor' && tag === 'css') {
              return processorFile;
            }

            return null;
          },
        }),
      ],
    });

    expect(hasCssOutput(result)).toBe(false);

    const jsText = getJsText(result);
    expect(jsText).not.toBeNull();
    expect(jsText).not.toContain('test-css-processor');
    expect(jsText).not.toContain('css`');
  } finally {
    process.chdir(cwd);
  }
});
