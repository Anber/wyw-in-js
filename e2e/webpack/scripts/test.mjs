import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import colors from 'picocolors';
import prettier from 'prettier';

const require = createRequire(import.meta.url);
const webpack = require('webpack');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_DIR = path.resolve(__dirname, '..');

const normalizeLineEndings = (value) =>
  value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const runBuild = async () => {
  const outDir = path.resolve(PKG_DIR, 'dist');
  await fs.rm(outDir, { recursive: true, force: true });

  const config = {
    mode: 'development',
    context: PKG_DIR,
    entry: path.resolve(PKG_DIR, 'src', 'index.js'),
    output: {
      path: outDir,
      filename: 'bundle.js',
      clean: true,
    },
    module: {
      rules: [
        {
          test: /\.js$/,
          use: [{ loader: '@wyw-in-js/webpack-loader' }],
        },
        {
          test: /\.wyw-in-js\.css$/,
          type: 'asset/resource',
          generator: {
            filename: '[name][ext]',
          },
        },
      ],
    },
    resolve: {
      extensions: ['.js'],
    },
    cache: false,
    stats: 'errors-only',
  };

  await new Promise((resolve, reject) => {
    webpack(config, (err, stats) => {
      if (err) {
        reject(err);
        return;
      }
      if (stats?.hasErrors()) {
        reject(new Error(stats.toString({ all: false, errors: true })));
        return;
      }
      resolve();
    });
  });
};

const main = async () => {
  console.log(colors.blue('Package directory:'), PKG_DIR);

  await runBuild();

  const outDir = path.resolve(PKG_DIR, 'dist');
  const entries = await fs.readdir(outDir);
  const cssFiles = entries.filter((file) => file.endsWith('.wyw-in-js.css'));

  if (cssFiles.length === 0) {
    throw new Error('No .wyw-in-js.css assets were emitted');
  }

  const cssOutputRaw = (
    await Promise.all(
      cssFiles
        .sort((a, b) => a.localeCompare(b))
        .map((file) => fs.readFile(path.resolve(outDir, file), 'utf8'))
    )
  ).join('\n');

  const cssOutput = await prettier.format(
    normalizeLineEndings(cssOutputRaw),
    {
      parser: 'css',
    }
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
};

main().then(
  () => {
    console.log(colors.green('✅ Webpack E2E test passed'));
    process.exit(0);
  },
  (error) => {
    console.error(colors.red('Error:'), error);
    process.exit(1);
  }
);
