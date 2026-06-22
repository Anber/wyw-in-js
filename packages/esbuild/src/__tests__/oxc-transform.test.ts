import fs from 'fs';
import os from 'os';
import path from 'path';

import * as esbuild from 'esbuild';

import wywInJS from '../index';

const getCssText = (result: esbuild.BuildResult): string | null => {
  const css = result.outputFiles?.find((file) => file.path.endsWith('.css'));
  return css?.text ?? null;
};

it('can apply oxcOptions.transform to source code before esbuild/WyW transform', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esbuild-127-'));
  const outdir = path.join(root, 'dist');

  const entryFile = path.join(root, 'main.tsx');

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
      `const color = __COLOR__;`,
      `export const className = css\`color: \${color};\`;`,
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
      oxcOptions: {
        transform: {
          define: {
            __COLOR__: '"red"',
          },
        },
      },
      tagResolver: (source: string, tag: string) => {
        if (source === 'test-css-processor' && tag === 'css') {
          return processorFile;
        }

        return null;
      },
    };

    const transformed = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      format: 'esm',
      write: false,
      outdir,
      plugins: [wywInJS({ ...basePluginOptions, oxcTransform: true })],
    });

    const cssText = getCssText(transformed);
    expect(cssText).not.toBeNull();
    expect(cssText).toContain('red');
  } finally {
    process.chdir(cwd);
  }
});

it('preserves esbuild jsx runtime options when transforming TSX', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esbuild-jsx-'));
  const outdir = path.join(root, 'dist');

  const entryFile = path.join(root, 'main.tsx');

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
      `export default function Index() {`,
      `  return <main className={className}>Hello</main>;`,
      `}`,
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
    const transformed = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      external: ['react/jsx-runtime'],
      format: 'esm',
      jsx: 'automatic',
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

    const jsText = transformed.outputFiles?.find((file) =>
      file.path.endsWith('.js')
    )?.text;

    expect(jsText).toContain('react/jsx-runtime');
    expect(jsText).not.toContain('React.createElement');
  } finally {
    process.chdir(cwd);
  }
});
