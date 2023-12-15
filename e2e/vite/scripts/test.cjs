// @ts-check

const fs = require('node:fs/promises');
const path = require('node:path');
const colors = require('picocolors');
const prettier = require('prettier');
const { build } = require('vite');
const wyw = require('@wyw-in-js/vite');

const PKG_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.resolve(PKG_DIR, 'dist');

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

async function buildArtefact() {
  await build({
    build: {
      manifest: true,
      outDir: DIST_DIR,
    },
    configFile: false,
    plugins: [wyw.default()],
  });
}

async function getCSSFromManifest() {
  const manifestPath = path.resolve(DIST_DIR, '.vite', 'manifest.json');
  const manifest = require(manifestPath);

  if (!manifest['index.html']) {
    throw new Error('No index.html in manifest');
  }

  if (!manifest['index.html'].css) {
    throw new Error('No CSS in manifest');
  }

  if (manifest['index.html'].css.length !== 1) {
    throw new Error('More than one CSS in manifest');
  }

  const cssFilePath = path.resolve(DIST_DIR, manifest['index.html'].css[0]);
  const cssSnapshot = await fs.readFile(cssFilePath, 'utf-8');

  return prettier.format(cssSnapshot, {
    parser: 'css',
  });
}

async function main() {
  console.log(colors.blue('Package directory:'), PKG_DIR);

  try {
    await fs.rm(DIST_DIR, { recursive: true });
  } catch (err) {}

  await buildArtefact();

  const cssOutput = normalizeLineEndings(await getCSSFromManifest());
  const cssFixture = normalizeLineEndings(
    await fs.readFile(path.resolve(PKG_DIR, 'fixture.css'), 'utf-8')
  );

  if (cssOutput !== cssFixture) {
    console.log(colors.red('Output CSS:'));
    console.log(cssOutput);
    console.log(colors.red('Expected CSS:'));
    console.log(cssFixture);

    throw new Error('CSS output does not match fixture');
  }
}

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
