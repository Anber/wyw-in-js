import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import colors from 'picocolors';
import prettier from 'prettier';
import { build } from 'vite';

import wyw from '@wyw-in-js/vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PKG_DIR = path.resolve(__dirname, '..');

const normalizeLineEndings = (value) =>
  value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const buildArtefact = async (outDir, pluginOptions) => {
  await build({
    build: {
      manifest: true,
      outDir,
      cssMinify: false,
    },
    configFile: false,
    resolve: {
      alias: {
        '@': path.resolve(PKG_DIR, 'src'),
      },
    },
    plugins: [pluginOptions ? wyw(pluginOptions) : wyw()],
  });
};

const getCSSFromManifest = async (outDir) => {
  const manifestPath = path.resolve(outDir, '.vite', 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

  if (!manifest['index.html']) {
    throw new Error('No index.html in manifest');
  }

  if (!manifest['index.html'].css) {
    throw new Error('No CSS in manifest');
  }

  if (manifest['index.html'].css.length !== 1) {
    throw new Error('More than one CSS in manifest');
  }

  const cssFilePath = path.resolve(outDir, manifest['index.html'].css[0]);
  const cssSnapshot = await fs.readFile(cssFilePath, 'utf-8');

  return prettier.format(cssSnapshot, {
    parser: 'css',
  });
};

const main = async () => {
  console.log(colors.blue('Package directory:'), PKG_DIR);

  const outDir = path.resolve(PKG_DIR, 'dist');
  const testCases = [
    {
      name: 'default',
      fixturePath: path.resolve(PKG_DIR, 'fixture.css'),
    },
    {
      name: 'keepComments',
      fixturePath: path.resolve(PKG_DIR, 'fixture.keep-comments.css'),
      pluginOptions: { keepComments: true },
    },
  ];

  for (const testCase of testCases) {
    console.log(colors.blue('Running case:'), testCase.name);
    await fs.rm(outDir, { recursive: true, force: true });

    await buildArtefact(outDir, testCase.pluginOptions);

    const cssOutput = normalizeLineEndings(await getCSSFromManifest(outDir));
    const cssFixture = normalizeLineEndings(
      await fs.readFile(testCase.fixturePath, 'utf-8')
    );

    if (cssOutput !== cssFixture) {
      console.log(colors.red(`[${testCase.name}] Output CSS:`));
      console.log(cssOutput);
      console.log(colors.red(`[${testCase.name}] Expected CSS:`));
      console.log(cssFixture);

      throw new Error(`[${testCase.name}] CSS output does not match fixture`);
    }
  }
};

main().then(
  () => {
    console.log(colors.green('✅ Vite E2E test passed'));
    process.exit(0);
  },
  (error) => {
    console.error(colors.red('Error:'), error);
    process.exit(1);
  }
);
