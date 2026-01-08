import fs from 'fs';
import os from 'os';
import path from 'path';

import * as esbuild from 'esbuild';

import wywInJS from '../index';

const getCssText = (result: esbuild.BuildResult): string | null => {
  const css = result.outputFiles?.find((file) => file.path.endsWith('.css'));
  return css?.text ?? null;
};

it('transforms node_modules when transformLibraries is enabled', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esbuild-124-'));
  const outdir = path.join(root, 'dist');

  const nmRoot = path.join(root, 'node_modules');
  const processorStubDir = path.join(nmRoot, 'test-css-processor');
  const libDir = path.join(nmRoot, 'test-lib');

  fs.mkdirSync(processorStubDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });

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

  const entryFile = path.join(libDir, 'index.js');
  fs.writeFileSync(
    entryFile,
    [
      `import { css } from 'test-css-processor';`,
      ``,
      `export const className = css\``,
      `  color: red;`,
      `\`;`,
      ``,
      `export const _usage = [className];`,
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
    const basePluginOptions = {
      configFile: false,
      tagResolver: (source: string, tag: string) => {
        if (source === 'test-css-processor' && tag === 'css') {
          return processorFile;
        }

        return null;
      },
    };

    const skipped = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      format: 'esm',
      write: false,
      outdir,
      plugins: [wywInJS(basePluginOptions)],
    });

    expect(getCssText(skipped)).toBeNull();

    const transformed = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      format: 'esm',
      write: false,
      outdir,
      plugins: [wywInJS({ ...basePluginOptions, transformLibraries: true })],
    });

    const cssText = getCssText(transformed);
    expect(cssText).not.toBeNull();
    expect(cssText).toContain('red');
  } finally {
    process.chdir(cwd);
  }
});
