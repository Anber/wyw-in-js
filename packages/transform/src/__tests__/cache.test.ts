import { createHash } from 'crypto';
import fs from 'node:fs';

import { TransformCacheCollection } from '../cache';
import type { IEntrypointDependency } from '../transform/Entrypoint.types';

// Mocking the minimal interface needed by the cache
type MockEntrypoint = {
  dependencies: Map<string, Pick<IEntrypointDependency, 'resolved'>>;
  generation: number;
  initialCode: string;
  name: string;
};

jest.mock('node:fs');

const mockedReadFileSync = jest.mocked(fs.readFileSync);

function hashContent(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

const setupCacheWithEntrypoint = (
  filename: string,
  content: string,
  dependencies: MockEntrypoint['dependencies'] = new Map()
): {
  cache: TransformCacheCollection<MockEntrypoint>;
  entrypoint: MockEntrypoint;
} => {
  const cache = new TransformCacheCollection<MockEntrypoint>();
  const entrypoint: MockEntrypoint = {
    name: filename,
    initialCode: content,
    dependencies,
    generation: 1,
  };

  cache.add('entrypoints', filename, entrypoint);

  // Manually set content hash as `add` does
  // @ts-expect-error contentHashes is private
  const { contentHashes } = cache;
  contentHashes.set(filename, hashContent(content));

  return { cache, entrypoint };
};

describe('TransformCacheCollection', () => {
  beforeEach(() => {
    mockedReadFileSync.mockClear();
  });

  describe('invalidateIfChanged', () => {
    it('should not invalidate if content is unchanged', () => {
      const filename = 'test.js';
      const content = 'console.log("hello")';
      const { cache } = setupCacheWithEntrypoint(filename, content);

      const invalidated = cache.invalidateIfChanged(filename, content);

      expect(invalidated).toBe(false);
      expect(cache.has('entrypoints', filename)).toBe(true);
    });

    it('should invalidate if content has changed', () => {
      const filename = 'test.js';
      const content = 'console.log("hello")';
      const newContent = 'console.log("world")';
      const { cache } = setupCacheWithEntrypoint(filename, content);

      const invalidated = cache.invalidateIfChanged(filename, newContent);

      expect(invalidated).toBe(true);
      expect(cache.has('entrypoints', filename)).toBe(false);
    });

    it('should invalidate dependency if its content changed', () => {
      const depName = 'dep.js';
      const depContent = 'export const b = 2;';
      const newDepContent = 'export const b = 3;';
      const parentName = 'parent.js';
      const parentContent = 'import { b } from "./dep.js"; console.log(b);';

      const { entrypoint: depEntrypoint } = setupCacheWithEntrypoint(
        depName,
        depContent
      );

      const parentDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./dep.js', { resolved: depName }]]);
      const { cache } = setupCacheWithEntrypoint(
        parentName,
        parentContent,
        parentDeps
      );

      // Add the dependency entry to the main cache
      cache.add('entrypoints', depName, depEntrypoint as any);
      (cache as any).contentHashes.set(depName, hashContent(depContent));

      // Mock fs read to return new content for the dependency
      mockedReadFileSync.mockImplementation((path) => {
        if (path === depName) {
          return newDepContent;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      const invalidated = cache.invalidateIfChanged(
        parentName,
        parentContent // Parent content itself hasn't changed
      );

      expect(invalidated).toBe(false); // Parent itself wasn't invalidated
      expect(cache.has('entrypoints', parentName)).toBe(true); // Parent still in cache
      expect(cache.has('entrypoints', depName)).toBe(false); // Dependency invalidated
      expect(mockedReadFileSync).toHaveBeenCalledWith(depName, 'utf8');
    });

    it('should invalidate recursive dependency if its content changed', () => {
      const leafName = 'leaf.js';
      const leafContent = 'export const c = 3;';
      const newLeafContent = 'export const c = 4;';
      const intermediateName = 'intermediate.js';
      const intermediateContent =
        'import { c } from "./leaf.js"; export const b = c + 1;';
      const rootName = 'root.js';
      const rootContent =
        'import { b } from "./intermediate.js"; console.log(b);';

      // Setup leaf
      const { entrypoint: leafEntrypoint } = setupCacheWithEntrypoint(
        leafName,
        leafContent
      );

      // Setup intermediate
      const intermediateDeps = new Map<
        string,
        Pick<IEntrypointDependency, 'resolved'>
      >([['./leaf.js', { resolved: leafName }]]);
      const { entrypoint: intermediateEntrypoint } = setupCacheWithEntrypoint(
        intermediateName,
        intermediateContent,
        intermediateDeps
      );

      // Setup root
      const rootDeps = new Map<string, Pick<IEntrypointDependency, 'resolved'>>(
        [['./intermediate.js', { resolved: intermediateName }]]
      );
      const { cache } = setupCacheWithEntrypoint(
        rootName,
        rootContent,
        rootDeps
      );

      // Add all to the main cache
      cache.add('entrypoints', leafName, leafEntrypoint as any);
      (cache as any).contentHashes.set(leafName, hashContent(leafContent));
      cache.add('entrypoints', intermediateName, intermediateEntrypoint as any);
      (cache as any).contentHashes.set(
        intermediateName,
        hashContent(intermediateContent)
      );

      // Mock fs read to return new content for the leaf dependency
      mockedReadFileSync.mockImplementation((path) => {
        if (path === leafName) {
          return newLeafContent;
        }
        if (path === intermediateName) {
          // intermediate content hasn't actually changed on disk
          return intermediateContent;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      const invalidated = cache.invalidateIfChanged(
        rootName,
        rootContent // Root content itself hasn't changed
      );

      expect(invalidated).toBe(false); // Root itself wasn't invalidated
      expect(cache.has('entrypoints', rootName)).toBe(true); // Root still in cache
      expect(cache.has('entrypoints', intermediateName)).toBe(true); // Intermediate still in cache
      expect(cache.has('entrypoints', leafName)).toBe(false); // Leaf dependency invalidated
      expect(mockedReadFileSync).toHaveBeenCalledWith(intermediateName, 'utf8');
      expect(mockedReadFileSync).toHaveBeenCalledWith(leafName, 'utf8');
    });

    it('should handle cyclic dependencies without infinite recursion', () => {
      const fileA = 'a.js';
      const contentA = 'import { b } from "./b.js"; export const a = () => b;';
      const fileB = 'b.js';
      const contentB = 'import { a } from "./a.js"; export const b = () => a;';

      const depsA = new Map<string, Pick<IEntrypointDependency, 'resolved'>>([
        ['./b.js', { resolved: fileB }],
      ]);
      const depsB = new Map<string, Pick<IEntrypointDependency, 'resolved'>>([
        ['./a.js', { resolved: fileA }],
      ]);

      const { cache } = setupCacheWithEntrypoint(fileA, contentA, depsA);
      const { entrypoint: entryB } = setupCacheWithEntrypoint(
        fileB,
        contentB,
        depsB
      );

      cache.add('entrypoints', fileB, entryB as any);
      (cache as any).contentHashes.set(fileB, hashContent(contentB));

      mockedReadFileSync.mockImplementation((path) => {
        if (path === fileB) {
          return contentB;
        }
        if (path === fileA) {
          return contentA;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      const invalidated = cache.invalidateIfChanged(fileA, contentA);

      expect(invalidated).toBe(false);
      expect(cache.has('entrypoints', fileA)).toBe(true);
      expect(cache.has('entrypoints', fileB)).toBe(true);
      expect(mockedReadFileSync).toHaveBeenCalledWith(fileB, 'utf8');
      expect(mockedReadFileSync).toHaveBeenCalledWith(fileA, 'utf8');
      expect(mockedReadFileSync).toHaveBeenCalledTimes(2);
    });

    it('should still invalidate cyclic dependency content changes', () => {
      const fileA = 'a.js';
      const contentA = 'import { b } from "./b.js"; export const a = () => b;';
      const fileB = 'b.js';
      const contentB = 'import { a } from "./a.js"; export const b = () => a;';
      const newContentB = 'import { a } from "./a.js"; export const b = 42;';

      const depsA = new Map<string, Pick<IEntrypointDependency, 'resolved'>>([
        ['./b.js', { resolved: fileB }],
      ]);
      const depsB = new Map<string, Pick<IEntrypointDependency, 'resolved'>>([
        ['./a.js', { resolved: fileA }],
      ]);

      const { cache } = setupCacheWithEntrypoint(fileA, contentA, depsA);
      const { entrypoint: entryB } = setupCacheWithEntrypoint(
        fileB,
        contentB,
        depsB
      );

      cache.add('entrypoints', fileB, entryB as any);
      (cache as any).contentHashes.set(fileB, hashContent(contentB));

      mockedReadFileSync.mockImplementation((path) => {
        if (path === fileA) {
          return contentA;
        }
        if (path === fileB) {
          return contentB;
        }
        throw new Error(`Unexpected readFileSync call: ${path}`);
      });

      const invalidated = cache.invalidateIfChanged(fileB, newContentB);

      expect(invalidated).toBe(true);
      expect(cache.has('entrypoints', fileB)).toBe(false);
      expect(cache.has('entrypoints', fileA)).toBe(true);
      expect(mockedReadFileSync).toHaveBeenCalledWith(fileA, 'utf8');
      expect(mockedReadFileSync).toHaveBeenCalledWith(fileB, 'utf8');
    });
  });

  it('removes entry and content hash when value is undefined', () => {
    const filename = 'empty-style.js';
    const content = '';
    const { cache } = setupCacheWithEntrypoint(filename, content);

    // @ts-expect-error accessing private field for assertions
    const { contentHashes } = cache;

    expect(cache.has('entrypoints', filename)).toBe(true);
    expect(contentHashes.has(filename)).toBe(true);

    expect(() => {
      cache.add('entrypoints', filename, undefined as any);
    }).not.toThrow();

    expect(cache.has('entrypoints', filename)).toBe(false);
    expect(contentHashes.has(filename)).toBe(false);
  });
});
