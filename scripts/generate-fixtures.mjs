import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'os';
import { join, relative, isAbsolute } from 'path';

import { install } from '@pnpm/core';
import { createOrConnectStoreController } from '@pnpm/store-connection-manager';
import { finishWorkers } from '@pnpm/worker';
import { Command } from 'commander';
import { globSync } from 'glob';
import packageJSON from 'package-json';
import * as prettier from 'prettier';
import semver from 'semver';

import { configs } from './helpers/generators-configs.mjs';
import { readPackage } from './helpers/readPackage.mjs';

const program = new Command();

program
  .argument('<fixtures-folder>', 'Folder with fixtures')
  .action(async (fixturesFolderArg) => {
    const fixturesFolder = isAbsolute(fixturesFolderArg)
      ? fixturesFolderArg
      : join(process.cwd(), fixturesFolderArg);

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
      a.version && b.version ? semver.compare(a.version, b.version) : 0
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

    const inputFixtures = globSync(`${fixturesFolder}/*.input.*`);

    const prettierOptions = await prettier.resolveConfig(fixturesFolder);

    const results = new Map();

    const formatCode = (code) =>
      code
        .replace(/\n+$/, '')
        .split('\n')
        .map((line, idx) => `\t${(idx + 1).toString().padStart(2)}\t${line}`)
        .join('\n');

    const installOptions = {
      confirmModulesPurge: false,
      dir: tempDir,
      hooks: { readPackage },
      lockfileDir: tempDir,
      pkgRoot: tempDir,
      storeController: controller.ctrl,
      storeDir: storeDir,
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
              [name]: version,
            }
          : {},
      };

      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify(manifest, null, 2)
      );

      for (const transformer of transformers) {
        const deps = transformer.deps ?? [];

        console.log(`Installing dependencies for ${transformer.name} …`);

        const depsObject = deps.reduce((acc, dep) => {
          const [name, version] = dep.split(':');
          acc[name] = version;
          return acc;
        }, {});

        try {
          await install(
            {
              ...manifest,
              devDependencies: {
                ...manifest.devDependencies,
                ...depsObject,
              },
            },
            installOptions
          );
        } catch (e) {
          if (e.code === 'ERR_PNPM_PEER_DEP_ISSUES') {
            console.log(
              'ERR_PNPM_PEER_DEP_ISSUES',
              JSON.stringify(e.issuesByProjects['.'], null, 2)
            );
            process.exit(1);
          } else {
            console.error(e);
          }

          continue;
        }

        const source = `
      const process = require('node:process');
      const { readFileSync } = require('fs');
      const transform = ${transformer.toString()};
      const source = readFileSync(process.argv[2], 'utf8');
      console.log(transform(source));
    `;
        writeFileSync(join(tempDir, 'transform.js'), source);

        const transformerName = version
          ? `${transformer.name}-${versionToPath(version)}`
          : transformer.name;
        const startTime = performance.now();
        console.log(`Running ${transformerName} …`);

        for (const inputFixture of inputFixtures) {
          if (!results.has(inputFixture)) {
            results.set(inputFixture, new Map());
          }

          const resultsForFixture = results.get(inputFixture);
          const fixtureName = relative(fixturesFolder, inputFixture);

          try {
            const result = execSync(
              `node ${tempDir}/transform.js "${inputFixture}"`,
              {
                cwd: tempDir,
                env: {
                  BROWSERSLIST_IGNORE_OLD_DATA: 1,
                },
              }
            );

            const code = await prettier.format(result.toString(), {
              ...prettierOptions,
              filepath: inputFixture,
            });

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
              writeFileSync(
                join(outputDir, `${transformerName}.input.js`),
                code
              );

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
          `Finished ${transformerName} in ${(
            (endTime - startTime) /
            1000
          ).toFixed(3)}s`
        );
      }
    }

    await rmSync(tempDir, { recursive: true });

    await finishWorkers();
  });

program.parse();
