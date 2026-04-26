import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';

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

describe('transform static import value inlining', () => {
  it('inlines a direct imported literal without keeping the runtime import', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();

    writeFileSync(depFile, `export const color = 'red';`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './tokens.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache);

      expect(result.cssText).toContain('color:red');
      expect(result.code).not.toContain('./tokens.js');
      expect(result.dependencies).toContain(depFile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves literals through explicit re-export chains', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const barrelFile = join(root, 'barrel.js');
    const depFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();

    writeFileSync(depFile, `export const spacing = [4, 8];`);
    writeFileSync(barrelFile, `export { spacing } from './tokens.js';`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { spacing } from './barrel.js';

        export const className = css\`
          margin: ${'${spacing[1]}'}px;
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache);

      expect(result.cssText).toContain('margin:8px');
      expect(result.code).not.toContain('./barrel.js');
      expect(result.dependencies).toEqual(
        expect.arrayContaining([barrelFile, depFile])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines imported fixed objects for CSS object interpolation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'theme.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      depFile,
      dedent`
        export const rules = {
          color: 'red',
          display: 'block',
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { rules } from './theme.js';

        export const className = css\`
          ${'${rules}'};
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache);

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('display:block');
      expect(result.code).not.toContain('./theme.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to eval for unsafe dependency modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'unsafe.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      depFile,
      dedent`
        const color = String('red');
        export { color };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './unsafe.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache);

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain('./unsafe.js');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates cached output when a transitive static dependency changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const barrelFile = join(root, 'barrel.js');
    const depFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();

    writeFileSync(depFile, `export const color = 'red';`);
    writeFileSync(barrelFile, `export { color } from './tokens.js';`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './barrel.js';

        export const className = css\`
          color: ${'${color}'};
        \`;
      `
    );

    try {
      const first = await runTransform(root, entryFile, cache);
      writeFileSync(depFile, `export const color = 'blue';`);
      const second = await runTransform(root, entryFile, cache);

      expect(first.cssText).toContain('color:red');
      expect(second.cssText).toContain('color:blue');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
