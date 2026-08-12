import fs from 'fs';
import os from 'os';
import path from 'path';

import * as babel from '@babel/core';
import dedent from 'dedent';

import { logger } from '@wyw-in-js/shared';
import type { StrictOptions } from '@wyw-in-js/shared';

import { TransformCacheCollection } from '../cache';
import { Entrypoint } from '../transform/Entrypoint';
import type { LoadAndParseFn } from '../transform/Entrypoint.types';
import type { Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const pluginOptions: StrictOptions = {
  babelOptions: {
    babelrc: false,
    configFile: false,
    presets: [
      ['@babel/preset-env', { loose: true }],
      '@babel/preset-typescript',
    ],
  },
  displayName: false,
  extensions: ['.cjs', '.js', '.jsx', '.ts', '.tsx'],
  features: {
    dangerousCodeRemover: true,
    globalCache: true,
    happyDOM: true,
    softErrors: false,
    useBabelConfigs: true,
    useWeakRefInEval: true,
  },
  highPriorityPlugins: [],
  rules: [],
};

const createServices = (
  cache: TransformCacheCollection,
  filename: string
): Services => {
  const loadAndParseFn: LoadAndParseFn = (services, name, loadedCode) => ({
    get ast() {
      return services.babel.parseSync(loadedCode ?? '', {
        filename: name,
        presets: [
          ['@babel/preset-env', { loose: true }],
          '@babel/preset-typescript',
        ],
      })!;
    },
    code: loadedCode!,
    evaluator: jest.fn(),
    evalConfig: {},
  });

  return {
    babel,
    cache,
    emitWarning: jest.fn(),
    loadAndParseFn,
    log: logger,
    eventEmitter: EventEmitter.dummy,
    options: {
      filename,
      pluginOptions,
    },
  };
};

// This is the "prove the loop end-to-end" half of the reproduction for
// pr-description-3-restart-cap.md. cache.evicted-dependency-loop.test.ts
// proves the fixed point exists in `TransformCacheCollection` in isolation;
// this test drives the real production entrypoint-creation path
// (`Entrypoint.createRoot` / `Entrypoint.innerCreate`) to show it reaches
// that same fixed point reaches the production entrypoint-creation code path,
// and pins the fix: once `didDependencyChange` gets the same content-hash
// escape hatch for ordinary dependencies, repeated requests for the parent
// converge and stop regenerating it.
//
// `cache.invalidateForFile()` below is exactly what two call sites on `main`
// do to a dependency that hasn't changed:
//   - packages/transform/src/transform/generators/workflow.ts:71/:115
//     (`cache.delete('entrypoints', ...)`, a root bundler pass over a plain
//     dependency)
//   - packages/vite/src/index.ts:977 (`handleHotUpdate` invalidates every
//     dependency of every affected module, changed or not)
describe('evicted-but-unchanged dependency no longer defeats entrypoint caching', () => {
  it('reuses the parent entrypoint across repeated requests, even after its dependency is evicted, as long as the dependency is unchanged', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-evicted-dep-'));
    const parentFile = path.join(root, 'parent.ts');
    const depFile = path.join(root, 'dep.ts');

    try {
      fs.writeFileSync(depFile, dedent`export const val = 'stable';`);
      fs.writeFileSync(
        parentFile,
        dedent`
          import { val } from './dep';
          export const result = val;
        `
      );

      const cache = new TransformCacheCollection();

      const depServices = createServices(cache, depFile);
      const depCode = fs.readFileSync(depFile, 'utf-8');
      Entrypoint.createRoot(depServices, depFile, ['val'], depCode);

      // Record the dependency's `fs` content hash + mtime, exactly as
      // `processImports.ts`'s cached-dependency reuse check
      // (`cache.checkFreshness`) does for every dependency on every pass.
      // This is what makes the later eviction land in the mtime-gated branch
      // of `didDependencyChange` (`cache.ts:426-505`) that contains the bug.
      cache.checkFreshness(depFile, depFile);

      const parentServices = createServices(cache, parentFile);
      const parentCode = fs.readFileSync(parentFile, 'utf-8');
      const firstEntrypoint = Entrypoint.createRoot(
        parentServices,
        parentFile,
        ['result'],
        parentCode
      );
      firstEntrypoint.addDependency({
        only: ['val'],
        resolved: depFile,
        source: './dep',
      });

      // Simulate the eviction both real call sites perform: drop the
      // dependency's *entrypoint* only. Its recorded content hash and mtime
      // (set by `Entrypoint.createRoot` above) are untouched, and the file
      // on disk is never written to again in this test.
      cache.invalidateForFile(depFile);

      const readFileSpy = jest.spyOn(fs, 'readFileSync');
      const depReadCountBefore = () =>
        readFileSpy.mock.calls.filter(([p]) => p === depFile).length;

      const generations: number[] = [firstEntrypoint.generation];

      // Repeatedly re-request the parent, exactly as a watch-mode rebuild or
      // a superseding create-during-processing retry would. Before the fix,
      // this never converged: each call saw `changed === true` from the
      // permanently-"changed" dependency and manufactured a brand new
      // superseding entrypoint, forever, though nothing changed on disk.
      for (let i = 0; i < 10; i += 1) {
        const next = Entrypoint.createRoot(
          parentServices,
          parentFile,
          ['result'],
          parentCode
        );
        generations.push(next.generation);
      }

      // Converges: the dependency's absence is recognized as stale cache
      // state rather than a real change, so the same entrypoint (and
      // generation) is reused across every one of these ten re-requests.
      for (let i = 1; i < generations.length; i += 1) {
        expect(generations[i]).toBe(generations[0]);
      }

      // The fix trades an unbounded number of full parent re-synthesis passes
      // for, at most, one cheap content-hash read of the dependency per check
      // (`didFileContentHashChange`) -- and the dependency's content on disk
      // never actually changed across any of them.
      expect(depReadCountBefore()).toBeLessThanOrEqual(generations.length);
      expect(fs.readFileSync(depFile, 'utf-8')).toBe(
        dedent`export const val = 'stable';`
      );

      readFileSpy.mockRestore();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// Note: an additional attempt to reproduce this same defect through the
// public `transform()` entrypoint (as a bundler plugin would call it,
// combined with a genuine `cache.invalidateForFile` HMR-style eviction) was
// made and abandoned -- not because the defect doesn't reach that far, but
// because `dangerousCodeRemover` shakes out any dependency that isn't
// actually required to compute the css tag's evaluated value in this
// minimal fixture, and the fixture's `TaggedTemplateProcessor` throws on
// interpolated values, making it impractical to keep the dependency alive
// without a heavier evaluation-capable processor fixture. The test above,
// which drives the identical `Entrypoint.createRoot` / `innerCreate`
// production code path directly, is the reproduction for this defect; see
// pr-description-3-restart-cap.md and cache.evicted-dependency-loop.test.ts
// for the full chain of evidence.
