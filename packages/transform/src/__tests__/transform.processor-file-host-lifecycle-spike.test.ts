import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import type { PluginOptions } from '../types';

const processorUtilsAnchor = join(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);
const SPIKE_ARTIFACT = 'wyw-in-js:processor-file-dependency-lifecycle-spike-v1';
const UNEXPECTED_ASYNC_ARTIFACT =
  'wyw-in-js:processor-file-host-lifecycle-spike-unexpected-async';

const processorSource = dedent`
  const { readFileSync } = require('fs');
  const { createRequire } = require('module');
  const { dirname, resolve } = require('path');
  const workspaceRequire = createRequire(${JSON.stringify(
    processorUtilsAnchor
  )});
  const { BaseProcessor } = workspaceRequire('@wyw-in-js/processor-utils');

  class ProcessorFileHostLifecycleSpike extends BaseProcessor {
    constructor(params, ...args) {
      super([params[0]], ...args);
      this.didBuild = false;
    }

    get asSelector() {
      return '.host-probe';
    }

    get value() {
      return this.astService.stringLiteral('host-probe');
    }

    build() {
      if (this.didBuild) return undefined;
      this.didBuild = true;

      const callerFilename = this.context.filename;
      const projectRoot = this.context.root;
      if (typeof callerFilename !== 'string' || typeof projectRoot !== 'string') {
        throw new Error('processor lifecycle spike requires caller filename and project root');
      }

      const rawPath = resolve(dirname(callerFilename), 'tokens.json');
      const bytes = readFileSync(rawPath);
      this.registerFileDependency(rawPath);
      this.registerFileDependency(rawPath);
      this.artifacts.push([
        ${JSON.stringify(SPIKE_ARTIFACT)},
        {
          baseClassName: this.className,
          bytes: bytes.length,
          callerFilename,
          projectRoot,
          readMode: 'processor-owned-sync-baseline',
          registrationMode: 'processor-file-dependency-v1',
          selector: this.asSelector,
        },
      ]);

      // BaseProcessor.build() is a synchronous void lifecycle. The current
      // host neither awaits nor observes a thenable returned by JavaScript.
      return {
        then: () => {
          this.artifacts.push([${JSON.stringify(
            UNEXPECTED_ASYNC_ARTIFACT
          )}, true]);
        },
      };
    }

    doEvaltimeReplacement() {
      this.replacer(this.astService.stringLiteral('host-probe'), false);
    }

    doRuntimeReplacement() {
      this.replacer(this.astService.stringLiteral('host-probe'), false);
    }
  }

  module.exports = { default: ProcessorFileHostLifecycleSpike };
`;

let packageId = 0;

const writeProcessorPackage = (root: string): string => {
  packageId += 1;
  const packageName = `processor-file-host-spike-${process.pid}-${packageId}`;
  const packageRoot = join(root, 'node_modules', packageName);
  const distRoot = join(packageRoot, 'dist');

  mkdirSync(distRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        main: './index.js',
        'wyw-in-js': {
          tags: {
            hostProbe: './dist/host-probe-processor.js',
          },
        },
      },
      null,
      2
    )
  );
  writeFileSync(join(packageRoot, 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(distRoot, 'host-probe-processor.js'), processorSource);

  return packageName;
};

const resolveFixtureImport =
  (root: string) =>
  async (specifier: string, importer: string): Promise<string | null> => {
    if (specifier.startsWith('.')) {
      return resolve(dirname(importer), specifier);
    }

    const packageMain = join(root, 'node_modules', specifier, 'index.js');
    return existsSync(packageMain) ? packageMain : null;
  };

const runTransform = (
  root: string,
  entryFile: string,
  cache: TransformCacheCollection,
  strategy: NonNullable<PluginOptions['eval']>['strategy']
) =>
  transform(
    {
      cache,
      options: {
        filename: entryFile,
        root,
        pluginOptions: {
          configFile: false,
          eval: { strategy },
          outputMetadata: true,
        },
      },
    },
    readFileSync(entryFile, 'utf8'),
    resolveFixtureImport(root)
  );

describe('processor file dependency lifecycle', () => {
  it.each(['static', 'execute'] as const)(
    'propagates a registered dependency through the %s lifecycle',
    async (strategy) => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-processor-file-host-'));
      const packageName = writeProcessorPackage(root);
      const entryFile = join(root, 'src', 'entry.js');
      const rawFile = join(root, 'src', 'tokens.json');
      const cache = new TransformCacheCollection();
      mkdirSync(dirname(entryFile), { recursive: true });
      writeFileSync(rawFile, '{"color":"tomato"}\n');
      writeFileSync(
        entryFile,
        dedent`
          import { hostProbe } from '${packageName}';

          export const probe = hostProbe({ source: './tokens.json' });
        `
      );

      try {
        const result = await runTransform(root, entryFile, cache, strategy);
        const artifacts =
          result.metadata?.processors.flatMap(
            (processor) => processor.artifacts
          ) ?? [];
        const spikeArtifacts = artifacts.filter(
          ([name]) => name === SPIKE_ARTIFACT
        );

        expect(spikeArtifacts).toHaveLength(1);
        expect(spikeArtifacts[0]?.[1]).toEqual({
          baseClassName: expect.any(String),
          bytes: Buffer.byteLength('{"color":"tomato"}\n'),
          callerFilename: entryFile,
          projectRoot: root,
          readMode: 'processor-owned-sync-baseline',
          registrationMode: 'processor-file-dependency-v1',
          selector: '.host-probe',
        });
        const spikePayload = spikeArtifacts[0]?.[1] as {
          baseClassName: string;
          selector: string;
        };
        expect(spikePayload.selector).not.toBe(
          `.${spikePayload.baseClassName}`
        );
        expect(artifacts.map(([name]) => name)).not.toContain(
          UNEXPECTED_ASYNC_ARTIFACT
        );
        expect(result.dependencies ?? []).toContain(rawFile);
        expect(
          (result.dependencies ?? []).filter(
            (dependency) => dependency === rawFile
          )
        ).toHaveLength(1);
        expect(result.cssText ?? '').toBe('');
        expect(result.code).toContain('export const probe = "host-probe";');
      } finally {
        disposeEvalBroker(cache);
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000
  );
});
