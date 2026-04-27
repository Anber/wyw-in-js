import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');
const styledProcessorFile = join(
  __dirname,
  '__fixtures__',
  'test-styled-processor.js'
);

const createResolver =
  (processorPath: string) => async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorPath;
    }

    if (what === 'test-styled-processor') {
      return styledProcessorFile;
    }

    if (what.startsWith('.')) {
      return resolve(dirname(importer), what);
    }

    return null;
  };

const runTransform = async (
  root: string,
  entryFile: string,
  cache: TransformCacheCollection,
  eventEmitter?: EventEmitter
) =>
  transform(
    {
      cache,
      eventEmitter,
      options: {
        filename: entryFile,
        root,
        pluginOptions: {
          configFile: false,
          tagResolver: (source, tag) => {
            if (source === 'test-css-processor' && tag === 'css') {
              return processorFile;
            }

            if (source === 'test-styled-processor' && tag === 'styled') {
              return styledProcessorFile;
            }

            return null;
          },
        },
      },
    },
    readFileSync(entryFile, 'utf8'),
    createResolver(processorFile)
  );

const createPerfEventRecorder = () => {
  const counts = new Map<string, number>();
  const eventEmitter = new EventEmitter(
    (labels, type) => {
      if (type !== 'start' || typeof labels.method !== 'string') {
        return;
      }

      counts.set(labels.method, (counts.get(labels.method) ?? 0) + 1);
    },
    () => 0,
    () => {}
  );

  return { counts, eventEmitter };
};

describe('transform static import value inlining', () => {
  it('inlines a direct imported literal without keeping the runtime import', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

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
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.code).not.toContain('./tokens.js');
      expect(result.dependencies).toContain(depFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
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

  it('inlines safe exports from modules with function declarations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'theme.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      depFile,
      dedent`
        export function formatColor(value) {
          return String(value);
        }

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
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('display:block');
      expect(result.code).not.toContain('./theme.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to eval for unsafe dependency modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'unsafe.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

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
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain('./unsafe.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to eval when a function module also has unsafe top-level values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'unsafe.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      depFile,
      dedent`
        const unused = String('side-effect boundary');

        export function formatColor(value) {
          return String(value);
        }

        export const color = 'red';

        void unused;
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
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain('./unsafe.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines imported styled primitive metadata without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        export const Base = styled.div\`
          color: red;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('font-size:12px');
      expect(result.cssText).toMatch(
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
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
