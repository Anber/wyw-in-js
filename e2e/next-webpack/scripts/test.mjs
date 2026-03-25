import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import colors from 'picocolors';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_DIR = path.resolve(__dirname, '..');

const normalizeLineEndings = (value) =>
  value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const runBuild = async () => {
  await fs.rm(path.resolve(PKG_DIR, '.next'), { recursive: true, force: true });

  const nextPackageJson = require.resolve('next/package.json', {
    paths: [PKG_DIR],
  });
  const nextBin = path.resolve(
    path.dirname(nextPackageJson),
    'dist',
    'bin',
    'next'
  );

  execFileSync(process.execPath, [nextBin, 'build', '--webpack'], {
    cwd: PKG_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: 'inherit',
  });
};

const readCssOutput = async () => {
  const cssDir = path.resolve(PKG_DIR, '.next', 'static', 'css');
  let entries = [];
  try {
    entries = await fs.readdir(cssDir);
  } catch {
    throw new Error('No CSS output directory found in .next/static/css');
  }

  const cssFiles = entries.filter((file) => file.endsWith('.css'));
  if (cssFiles.length === 0) {
    throw new Error('No CSS assets emitted by Next build');
  }

  const cssOutputRaw = (
    await Promise.all(
      cssFiles
        .sort((a, b) => a.localeCompare(b))
        .map((file) => fs.readFile(path.resolve(cssDir, file), 'utf8'))
    )
  ).join('\n');

  return normalizeLineEndings(cssOutputRaw);
};

const assertMatches = (css, pattern, label) => {
  if (!pattern.test(css)) {
    throw new Error(`Expected CSS output to include ${label}`);
  }
};

const main = async () => {
  console.log(colors.blue('Package directory:'), PKG_DIR);

  await runBuild();

  const cssOutput = await readCssOutput();

  assertMatches(cssOutput, /border:\s*1px\s+solid\s+blue/i, 'border');
  assertMatches(cssOutput, /height:\s*100px/i, 'height');
  assertMatches(cssOutput, /width:\s*200px/i, 'width');
  assertMatches(cssOutput, /font-size:\s*18px/i, 'font-size');
  assertMatches(cssOutput, /color:\s*tomato/i, 'color');
};

main().then(
  () => {
    console.log(colors.green('✅ Next Webpack E2E test passed'));
    process.exit(0);
  },
  (error) => {
    console.error(colors.red('Error:'), error);
    process.exit(1);
  }
);
