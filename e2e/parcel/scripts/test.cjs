// @ts-check

const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const colors = require('picocolors');
const prettier = require('prettier');

const PKG_DIR = path.resolve(__dirname, '..');

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * @param {string} html
 * @returns {string[]}
 */
function extractStylesheetHrefs(html) {
  const hrefs = [];
  const linkRe =
    /<link\s+[^>]*rel=(?:"|')stylesheet(?:"|')[^>]*>/gi;
  const hrefRe = /href=(?:"|')([^"']+)(?:"|')/i;

  const matches = html.match(linkRe) ?? [];
  for (const linkTag of matches) {
    const hrefMatch = hrefRe.exec(linkTag);
    if (hrefMatch?.[1]) {
      hrefs.push(hrefMatch[1]);
    }
  }

  return hrefs;
}

/**
 * @param {string} css
 * @returns {string}
 */
function stripSourceMappingURL(css) {
  return css.replace(/\n?\/\*# sourceMappingURL=.*?\*\/\s*$/s, '');
}

async function runBuild() {
  const outDir = path.resolve(PKG_DIR, 'dist');
  const cacheDir = path.resolve(PKG_DIR, '.parcel-cache');
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.rm(cacheDir, { recursive: true, force: true });

  const parcelPackageJson = require.resolve('parcel/package.json', {
    paths: [PKG_DIR],
  });
  const parcelBin = path.resolve(path.dirname(parcelPackageJson), 'lib/bin.js');

  execFileSync(
    process.execPath,
    [
      parcelBin,
      'build',
      'index.html',
      '--dist-dir',
      outDir,
      '--no-autoinstall',
      '--no-optimize',
    ],
    {
      cwd: PKG_DIR,
      env: { ...process.env, NODE_ENV: 'test', PARCEL_WORKERS: '0' },
      stdio: 'inherit',
    }
  );
}

async function main() {
  console.log(colors.blue('Package directory:'), PKG_DIR);

  await runBuild();

  const outDir = path.resolve(PKG_DIR, 'dist');
  const html = await fs.readFile(path.resolve(outDir, 'index.html'), 'utf8');
  const hrefs = extractStylesheetHrefs(html);

  if (hrefs.length === 0) {
    throw new Error('No stylesheet links found in dist/index.html');
  }

  if (hrefs.length > 1) {
    throw new Error('More than one stylesheet link found in dist/index.html');
  }

  const cssHref = hrefs[0].replace(/^\//, '');
  const cssFilePath = path.resolve(outDir, cssHref);
  const cssOutputRaw = await fs.readFile(cssFilePath, 'utf8');
  const cssOutput = await prettier.format(
    stripSourceMappingURL(normalizeLineEndings(cssOutputRaw)),
    { parser: 'css' }
  );

  const cssFixture = normalizeLineEndings(
    await fs.readFile(path.resolve(PKG_DIR, 'fixture.css'), 'utf8')
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
    console.log(colors.green('✅ Parcel E2E test passed'));
    process.exit(0);
  },
  (error) => {
    console.error(colors.red('Error:'), error);
    process.exit(1);
  }
);
