import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

import { install } from '@pnpm/core';
import { createOrConnectStoreController } from '@pnpm/store-connection-manager';
import { finishWorkers } from '@pnpm/worker';
import { globSync } from 'glob';
import packageJSON from 'package-json';
import semver from 'semver';

import { configs } from './helpers/generators-configs.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pathReplacements = [
  ['>=', 'gte'],
  ['<=', 'lte'],
  ['>', 'gt'],
  ['<', 'lt'],
  ['^', 'caret'],
  ['~', 'tilde'],
  ['*', 'star'],
  ['||', 'or'],
  ['&&', 'and'],
  ['.', '_'],
];

const versionToPath = (version) => {
  for (const [from, to] of pathReplacements) {
    version = version.replaceAll(from, to);
  }
  return version;
};

const environments = [];
for (const config of configs) {
  if (!config.version) {
    environments.push({
      name: config.name,
      transformers: config.transformers,
    });

    continue;
  }

  const { versions } = await packageJSON(config.name, {
    allVersions: true,
  });

  for (const version of Object.keys(versions)) {
    if (semver.satisfies(version, config.version)) {
      environments.push({
        name: config.name,
        transformers: config.transformers,
        version,
      });
    }
  }
}

environments.sort((a, b) =>
  a.version && b.version ? -semver.compare(a.version, b.version) : 0
);

const tempDir = mkdtempSync(join(tmpdir(), 'fixtures-'));
const storeDir = join(tempDir, 'store');

const controller = await createOrConnectStoreController({
  rawConfig: {},
  dir: tempDir,
  pkgRoot: tempDir,
  pnpmHomeDir: tempDir,
  cacheDir: join(tempDir, 'cache'),
  lockfileDir: tempDir,
  storeDir: storeDir,
});

const inputFixturesDir = join(__dirname, '__fixtures__');
const inputFixtures = globSync(`${inputFixturesDir}/*.input.*`);

const results = new Map();

const formatCode = (code) => {
  return code
    .replace(/\n+$/, '')
    .split('\n')
    .map((line, idx) => `\t${(idx + 1).toString().padStart(2)}\t${line}`)
    .join('\n');
};

console.log(`Total environments: ${environments.length}`);

for (const { name, transformers, version } of environments) {
  if (version) {
    console.log(`\nInstalling ${name}@${version} …`);
  } else {
    console.log(`\nInstalling ${name} …`);
  }

  const manifest = {
    name: 'fixtures',
    private: true,
    devDependencies: version
      ? {
          '@babel/preset-env': '^7.12.1',
          '@babel/preset-typescript': '^7.12.1',
          [name]: version,
        }
      : {
          '@babel/preset-env': '^7.12.1',
          '@babel/preset-typescript': '^7.12.1',
        },
  };

  writeFileSync(
    join(tempDir, 'package.json'),
    JSON.stringify(manifest, null, 2)
  );

  try {
    await install(manifest, {
      confirmModulesPurge: false,
      dir: tempDir,
      lockfileDir: tempDir,
      pkgRoot: tempDir,
      storeController: controller.ctrl,
      storeDir: storeDir,
    });
  } catch (e) {
    console.error(e);
    continue;
  }

  for (const transformer of transformers) {
    const { fn, deps } =
      typeof transformer === 'object'
        ? transformer
        : { fn: transformer, deps: [] };
    const source = `
      const process = require('node:process');
      const { readFileSync } = require('fs');
      const transform = ${fn.toString()};
      const source = readFileSync(process.argv[2], 'utf8');
      console.log(transform(source));
    `;
    writeFileSync(join(tempDir, 'transform.js'), source);

    const transformerName = version
      ? `${fn.name}-${versionToPath(version)}`
      : fn.name;
    const startTime = performance.now();
    console.log(`Running ${transformerName} …`);

    for (const inputFixture of inputFixtures) {
      if (!results.has(inputFixture)) {
        results.set(inputFixture, new Map());
      }

      const resultsForFixture = results.get(inputFixture);
      const fixtureName = relative(inputFixturesDir, inputFixture);

      try {
        const result = execSync(
          `node ${tempDir}/transform.js "${inputFixture}"`,
          {
            cwd: tempDir,
          }
        );

        const code = result.toString();

        if (resultsForFixture.has(code)) {
          console.log(
            `\tDuplicate result for ${transformerName}@${fixtureName}. Original ${resultsForFixture.get(
              code
            )}`
          );
        } else {
          resultsForFixture.set(code, transformerName);
          const outputDir = inputFixture.replace(/\.input\.[jt]s/, '');
          mkdirSync(outputDir, { recursive: true });
          writeFileSync(join(outputDir, `${transformerName}.input.js`), result);

          console.log(
            `\tResult for ${transformerName}@${fixtureName}:\n${formatCode(
              code
            )}\n`
          );
        }
      } catch (e) {
        console.error(`Error ${transformerName}@${fixtureName}:`, e);
      }
    }

    const endTime = performance.now();
    console.log(
      `Finished ${transformerName} in ${((endTime - startTime) / 1000).toFixed(
        3
      )}s`
    );
  }
}

await rmSync(tempDir, { recursive: true });

await finishWorkers();
