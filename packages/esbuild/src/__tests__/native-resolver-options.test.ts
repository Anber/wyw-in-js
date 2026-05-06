import fs from 'fs';
import os from 'os';
import path from 'path';

import * as esbuild from 'esbuild';

import wywInJS from '../index';

const getCssText = (result: esbuild.BuildResult): string | null => {
  const css = result.outputFiles?.find((file) => file.path.endsWith('.css'));
  return css?.text ?? null;
};

it('passes esbuild static aliases to native resolver options', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esbuild-alias-'));
  const outdir = path.join(root, 'dist');
  const srcDir = path.join(root, 'src');
  const entryFile = path.join(root, 'main.ts');
  const tokensFile = path.join(srcDir, 'tokens.ts');
  const nmRoot = path.join(root, 'node_modules');
  const processorStubDir = path.join(nmRoot, 'test-css-processor');

  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(processorStubDir, { recursive: true });

  fs.writeFileSync(tokensFile, `export const color = 'tomato';\n`, 'utf8');
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
      `import { color } from '@/tokens';`,
      ``,
      `export const className = css\``,
      `  color: ${'${color}'};`,
      `\`;`,
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
      alias: {
        '@': srcDir,
      },
      bundle: true,
      entryPoints: [entryFile],
      format: 'esm',
      outdir,
      plugins: [
        wywInJS({
          configFile: false,
          eval: {
            resolver: 'native',
          },
          tagResolver: (source: string, tag: string) => {
            if (source === 'test-css-processor' && tag === 'css') {
              return processorFile;
            }

            return null;
          },
        }),
      ],
      write: false,
    });

    expect(getCssText(result)).toContain('color: tomato');
  } finally {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
