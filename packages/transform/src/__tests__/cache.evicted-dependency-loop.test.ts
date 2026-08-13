import fs from 'node:fs';

import { TransformCacheCollection } from '../cache';
import type { IEntrypointDependency } from '../transform/Entrypoint.types';

// Mocking the minimal interface needed by the cache
type MockEntrypoint = {
  dependencies: Map<string, Pick<IEntrypointDependency, 'resolved'>>;
  generation: number;
  initialCode?: string;
  isProcessing?: boolean;
  invalidateOnDependencyChange?: Set<string>;
  invalidationDependencies?: Map<
    string,
    Pick<IEntrypointDependency, 'resolved'>
  >;
  name: string;
};

const mockedReadFileSync = jest.spyOn(fs, 'readFileSync');
const mockedStatSync = jest.spyOn(fs, 'statSync');

const setupCacheWithEntrypoint = (
  filename: string,
  content: string,
  dependencies: MockEntrypoint['dependencies'] = new Map(),
  invalidationDependencies: MockEntrypoint['invalidationDependencies'] = new Map()
): {
  cache: TransformCacheCollection<MockEntrypoint>;
  entrypoint: MockEntrypoint;
} => {
  const cache = new TransformCacheCollection<MockEntrypoint>();
  const entrypoint: MockEntrypoint = {
    name: filename,
    initialCode: content,
    dependencies,
    invalidationDependencies,
    generation: 1,
  };

  cache.add('entrypoints', filename, entrypoint);

  return { cache, entrypoint };
};

describe('TransformCacheCollection: evicted-but-unchanged dependency', () => {
  afterAll(() => {
    mockedReadFileSync.mockRestore();
    mockedStatSync.mockRestore();
  });

  beforeEach(() => {
    mockedReadFileSync.mockReset();
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('Unexpected readFileSync call.');
    });
    mockedStatSync.mockReset();
    mockedStatSync.mockImplementation(() => {
      throw new Error('Unexpected statSync call.');
    });
  });

  // This is the non-forced twin of the existing test
  // "does not invalidate an output-affecting dependency when only its
  // entrypoint was evicted" (cache.test.ts). That test covers a dependency
  // registered in `invalidateOnDependencyChange`, which goes through the
  // `forceContentCheck` escape hatch added in #319. Before the fix, an
  // *ordinary* dependency (the common case — most imports are not in that
  // set) took the non-forced branch in `didDependencyChange`, which had no
  // escape hatch: once its entrypoint was evicted (e.g. by `workflow.ts`'s
  // `cache.delete('entrypoints', ...)` for a plain bundler-root pass, or by
  // Vite's `handleHotUpdate` -> `invalidateForFile` on every dependency of an
  // affected module), it was reported "changed" on every subsequent check —
  // forever, even though the file on disk never changed. This test pins the
  // fix: an ordinary dependency now gets the same content-hash-backed escape
  // hatch, regardless of `forceContentCheck`.
  it('does not report an ordinary dependency as changed once its entrypoint is evicted, as long as its content is unchanged', () => {
    const depName = 'dep.js';
    const depContent = 'export const token = "red";';
    const parentName = 'parent.js';
    const parentContent =
      'import { token } from "./dep.js"; console.log(token);';

    const { entrypoint: depEntrypoint } = setupCacheWithEntrypoint(
      depName,
      depContent
    );

    const parentDeps = new Map<string, Pick<IEntrypointDependency, 'resolved'>>(
      [['./dep.js', { resolved: depName }]]
    );
    const { cache } = setupCacheWithEntrypoint(
      parentName,
      parentContent,
      parentDeps
    );
    // Deliberately no `invalidateOnDependencyChange` entry for depName: this
    // is the ordinary, non-output-affecting dependency case.

    cache.add('entrypoints', depName, depEntrypoint as any);

    mockedStatSync.mockImplementation((path) => {
      if (path === depName) {
        return { mtimeMs: 123 } as fs.Stats;
      }

      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });
    mockedReadFileSync.mockImplementation((path) => {
      if (path === depName) {
        return depContent;
      }

      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });

    // Record the dependency's `fs` content hash + mtime (what happens the
    // first time it's seen), then evict just its entrypoint -- the state
    // `workflow.ts`'s root-bundler-pass eviction and Vite's HMR
    // `invalidateForFile` both produce.
    expect(cache.checkFreshness(depName, depName)).toBe(false);
    cache.delete('entrypoints', depName);
    mockedReadFileSync.mockClear();

    // First check after eviction converges immediately: the dependency's
    // content hash is stable, so its missing entrypoint is treated as cache
    // churn rather than a real change.
    const firstCheck = cache.invalidateIfChanged(parentName, parentContent);
    expect(firstCheck).toBe(false);

    // Before the fix, `Entrypoint.innerCreate`'s pattern of re-adding the
    // parent (inheriting the *same* `dependencies` Map) immediately after
    // every invalidation re-armed the check against the same still-evicted
    // dependency, forever. Reproduce that re-arming pattern directly and
    // confirm it now stays converged across repeated checks, with the
    // dependency file never actually touched.
    for (let i = 0; i < 5; i += 1) {
      cache.add('entrypoints', parentName, {
        name: parentName,
        initialCode: parentContent,
        dependencies: parentDeps,
        invalidationDependencies: new Map(),
        generation: i + 2,
      });

      // eslint-disable-next-line no-await-in-loop
      const invalidated = cache.invalidateIfChanged(parentName, parentContent);
      expect(invalidated).toBe(false);
    }

    // The dependency's own recorded content hash never changed, and its
    // entrypoint was never re-created -- this is pure cache churn, not a
    // real change on disk.
    expect(cache.has('entrypoints', depName)).toBe(false);
  });

  it('keeps checking transitive dependencies after an intermediate entrypoint is evicted', () => {
    const leafName = 'leaf.js';
    const leafContent = 'export const token = "red";';
    const nextLeafContent = 'export const token = "blue";';
    const intermediateName = 'intermediate.js';
    const intermediateContent =
      'import { token } from "./leaf.js"; export { token };';
    const parentName = 'parent.js';
    const parentContent =
      'import { token } from "./intermediate.js"; console.log(token);';

    const leaf = setupCacheWithEntrypoint(leafName, leafContent).entrypoint;
    const intermediateDependencies = new Map<
      string,
      Pick<IEntrypointDependency, 'resolved'>
    >([['./leaf.js', { resolved: leafName }]]);
    const intermediate = setupCacheWithEntrypoint(
      intermediateName,
      intermediateContent,
      intermediateDependencies
    ).entrypoint;
    const parentDependencies = new Map<
      string,
      Pick<IEntrypointDependency, 'resolved'>
    >([['./intermediate.js', { resolved: intermediateName }]]);
    const { cache } = setupCacheWithEntrypoint(
      parentName,
      parentContent,
      parentDependencies
    );

    cache.add('entrypoints', intermediateName, intermediate);
    cache.add('entrypoints', leafName, leaf);

    let leafMtime = 200;
    let leafDiskContent = leafContent;
    mockedStatSync.mockImplementation((path) => {
      if (path === intermediateName) return { mtimeMs: 100 } as fs.Stats;
      if (path === leafName) return { mtimeMs: leafMtime } as fs.Stats;
      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });
    mockedReadFileSync.mockImplementation((path) => {
      if (path === intermediateName) return intermediateContent;
      if (path === leafName) return leafDiskContent;
      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });

    cache.invalidateIfChanged(
      intermediateName,
      intermediateContent,
      undefined,
      'fs'
    );
    cache.invalidateIfChanged(leafName, leafContent, undefined, 'fs');
    cache.delete('entrypoints', intermediateName);

    leafMtime = 201;
    leafDiskContent = nextLeafContent;
    mockedReadFileSync.mockClear();

    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
    expect(mockedReadFileSync).toHaveBeenCalledWith(intermediateName, 'utf8');
    expect(mockedReadFileSync).toHaveBeenCalledWith(leafName, 'utf8');
  });

  it('keeps treating a missing entrypoint as unknown when only its content hash is cached', () => {
    const depName = 'dep.js';
    const depContent = 'export const token = "red";';
    const parentName = 'parent.js';
    const parentContent =
      'import { token } from "./dep.js"; console.log(token);';
    const parentDependencies = new Map<
      string,
      Pick<IEntrypointDependency, 'resolved'>
    >([['./dep.js', { resolved: depName }]]);
    const { cache } = setupCacheWithEntrypoint(
      parentName,
      parentContent,
      parentDependencies
    );

    mockedStatSync.mockImplementation((path) => {
      if (path === depName) return { mtimeMs: 123 } as fs.Stats;
      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });
    mockedReadFileSync.mockImplementation((path) => {
      if (path === depName) return depContent;
      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });

    cache.invalidateIfChanged(depName, depContent, undefined, 'fs');

    expect(cache.has('entrypoints', depName)).toBe(false);
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
  });

  it('does not retain an incomplete graph when a processing entrypoint is evicted', () => {
    const depName = 'dep.js';
    const depContent = 'export const token = "red";';
    const parentName = 'parent.js';
    const parentContent =
      'import { token } from "./dep.js"; console.log(token);';
    const dep = setupCacheWithEntrypoint(depName, depContent).entrypoint;
    dep.isProcessing = true;
    const parentDependencies = new Map<
      string,
      Pick<IEntrypointDependency, 'resolved'>
    >([['./dep.js', { resolved: depName }]]);
    const { cache } = setupCacheWithEntrypoint(
      parentName,
      parentContent,
      parentDependencies
    );

    cache.add('entrypoints', depName, dep);
    mockedStatSync.mockImplementation((path) => {
      if (path === depName) return { mtimeMs: 123 } as fs.Stats;
      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });
    mockedReadFileSync.mockImplementation((path) => {
      if (path === depName) return depContent;
      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });

    cache.invalidateIfChanged(depName, depContent, undefined, 'fs');
    cache.delete('entrypoints', depName);

    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
  });

  it('forgets an evicted dependency graph when that file content changes', () => {
    const leafName = 'leaf.js';
    const leafContent = 'export const token = "red";';
    const depName = 'dep.js';
    const depContent = 'import { token } from "./leaf.js"; export { token };';
    const nextDepContent = 'export const token = "blue";';
    const parentName = 'parent.js';
    const parentContent =
      'import { token } from "./dep.js"; console.log(token);';
    const depDependencies = new Map<
      string,
      Pick<IEntrypointDependency, 'resolved'>
    >([['./leaf.js', { resolved: leafName }]]);
    const dep = setupCacheWithEntrypoint(
      depName,
      depContent,
      depDependencies
    ).entrypoint;
    const leaf = setupCacheWithEntrypoint(leafName, leafContent).entrypoint;
    const parentDependencies = new Map<
      string,
      Pick<IEntrypointDependency, 'resolved'>
    >([['./dep.js', { resolved: depName }]]);
    const { cache } = setupCacheWithEntrypoint(
      parentName,
      parentContent,
      parentDependencies
    );

    cache.add('entrypoints', depName, dep);
    cache.add('entrypoints', leafName, leaf);

    let depContentOnDisk = depContent;
    let depMtime = 100;
    mockedStatSync.mockImplementation((path) => {
      if (path === depName) return { mtimeMs: depMtime } as fs.Stats;
      if (path === leafName) return { mtimeMs: 200 } as fs.Stats;
      throw new Error(`Unexpected statSync call: ${String(path)}`);
    });
    mockedReadFileSync.mockImplementation((path) => {
      if (path === depName) return depContentOnDisk;
      if (path === leafName) return leafContent;
      throw new Error(`Unexpected readFileSync call: ${String(path)}`);
    });

    cache.invalidateIfChanged(depName, depContent, undefined, 'fs');
    cache.invalidateIfChanged(leafName, leafContent, undefined, 'fs');
    cache.delete('entrypoints', depName);

    depContentOnDisk = nextDepContent;
    depMtime = 101;
    expect(
      cache.invalidateIfChanged(depName, nextDepContent, undefined, 'fs')
    ).toBe(true);

    // The old graph described depContent, not nextDepContent. Until the
    // dependency is processed again, its graph is unknown and the parent
    // must stay conservative.
    expect(cache.invalidateIfChanged(parentName, parentContent)).toBe(true);
  });
});
