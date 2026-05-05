import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { logger } from '@wyw-in-js/shared';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import { Entrypoint } from '../transform/Entrypoint';
import type { IEvaluatedEntrypoint } from '../transform/EvaluatedEntrypoint';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const createResolver =
  (processorPath: string) => async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorPath;
    }

    if (what.startsWith('.')) {
      return resolve(dirname(importer), what);
    }

    return null;
  };

const seedEvaluatedCache = (
  cache: TransformCacheCollection,
  filename: string,
  exportsMap: Record<string, string>
) => {
  const source = readFileSync(filename, 'utf-8');
  cache.invalidateIfChanged(filename, source);

  const only = Object.keys(exportsMap);
  const exportsProxy = Entrypoint.createExports(logger.extend('cache-seed'));
  only.forEach((key) => {
    exportsProxy[key] = exportsMap[key];
  });

  const cachedEntrypoint: IEvaluatedEntrypoint = {
    dependencies: new Map(),
    evaluated: true,
    evaluatedOnly: only,
    exports: exportsProxy,
    generation: 1,
    hasTransformResult: false,
    hasWywMetadata: false,
    ignored: false,
    invalidationDependencies: new Map(),
    invalidateOnDependencyChange: new Set(),
    log: logger.extend('cache-seed'),
    name: filename,
    only,
    parents: [],
    preevalResult: null,
    seqId: -1,
    transformResultCode: null,
  };

  cache.add('entrypoints', filename, cachedEntrypoint);
};

const runTransform = async (
  root: string,
  entryFile: string,
  cache: TransformCacheCollection
) =>
  transform(
    {
      cache,
      options: {
        filename: entryFile,
        root,
        pluginOptions: {
          configFile: false,
          tagResolver: (source, tag) => {
            if (source === 'test-css-processor' && tag === 'css') {
              return processorFile;
            }

            return null;
          },
        },
      },
    },
    readFileSync(entryFile, 'utf8'),
    createResolver(processorFile)
  );

describe('transform partial evaluated cache reuse', () => {
  it('reprocesses partial cached evaluated dependency exports for static import loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-partial-cache-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'dep.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      depFile,
      dedent`
        export const foo1 = String('foo1');
        export const foo2 = String('foo2');
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { foo1 } from './dep.js';

        export const className = css\`
          font-size: \${foo1};
        \`;
      `
    );

    seedEvaluatedCache(cache, depFile, { foo1: 'cached-foo1' });

    try {
      const result = await runTransform(root, entryFile, cache);
      const cachedDep = cache.get('entrypoints', depFile) as
        | IEvaluatedEntrypoint
        | undefined;

      expect(result.cssText).toContain('foo1');
      expect(result.cssText).not.toContain('cached-foo1');
      expect(cachedDep?.exports.foo1).toBe('foo1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses complete cached evaluated dependency exports for static import loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-partial-cache-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'dep.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      depFile,
      dedent`
        export const foo1 = String('foo1');
        export const foo2 = String('foo2');
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { foo1 } from './dep.js';

        export const className = css\`
          font-size: \${foo1};
        \`;
      `
    );

    seedEvaluatedCache(cache, depFile, {
      foo1: 'cached-foo1',
      foo2: 'cached-foo2',
    });

    try {
      const result = await runTransform(root, entryFile, cache);
      const cachedDep = cache.get('entrypoints', depFile) as
        | IEvaluatedEntrypoint
        | undefined;

      expect(result.cssText).toContain('cached-foo1');
      expect(cachedDep?.exports.foo1).toBe('cached-foo1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reprocesses cached evaluated dependency exports when the dependency exports __wywPreval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-partial-cache-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'dep.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      depFile,
      dedent`
        export const foo1 = String('foo1');
        export const foo2 = String('foo2');
        export const __wywPreval = { value: () => foo1 };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { foo1 } from './dep.js';

        export const className = css\`
          font-size: \${foo1};
        \`;
      `
    );

    seedEvaluatedCache(cache, depFile, { foo1: 'cached-foo1' });

    try {
      const result = await runTransform(root, entryFile, cache);
      const cachedDep = cache.get('entrypoints', depFile) as
        | IEvaluatedEntrypoint
        | undefined;

      expect(result.cssText).toContain('foo1');
      expect(result.cssText).not.toContain('cached-foo1');
      expect(cachedDep?.exports.foo1).toBe('foo1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
