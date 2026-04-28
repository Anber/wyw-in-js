import {
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
import { transform } from '../transform';
import type { PluginOptions } from '../types';
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
  eventEmitter?: EventEmitter,
  pluginOptions: Partial<PluginOptions> = {},
  asyncResolve = createResolver(processorFile)
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
          ...pluginOptions,
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
    asyncResolve
  );

const createPerfEventRecorder = () => {
  const counts = new Map<string, number>();
  const events: Record<string, unknown>[] = [];
  const eventEmitter = new EventEmitter(
    (labels, type) => {
      if (type === 'single') {
        events.push(labels);
        return;
      }

      if (type !== 'start' || typeof labels.method !== 'string') {
        return;
      }

      counts.set(labels.method, (counts.get(labels.method) ?? 0) + 1);
    },
    () => 0,
    () => {}
  );

  return { counts, eventEmitter, events };
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
      expect(perf.counts.get('transform:evaluator') ?? 0).toBe(1);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can disable imported static value inlining with a feature flag', async () => {
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
        perf.eventEmitter,
        {
          features: {
            staticImportValues: false,
          },
        }
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain('./tokens.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
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

  it('keeps static resolve debug events disabled by default', async () => {
    const previousDebug = process.env.WYW_DEBUG_STATIC_RESOLVE;
    delete process.env.WYW_DEBUG_STATIC_RESOLVE;

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
      await runTransform(root, entryFile, cache, perf.eventEmitter);

      expect(
        perf.events.filter((event) => event.type === 'staticResolve')
      ).toEqual([]);
    } finally {
      if (previousDebug === undefined) {
        delete process.env.WYW_DEBUG_STATIC_RESOLVE;
      } else {
        process.env.WYW_DEBUG_STATIC_RESOLVE = previousDebug;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits static resolve debug rejection reasons when requested', async () => {
    const previousDebug = process.env.WYW_DEBUG_STATIC_RESOLVE;
    process.env.WYW_DEBUG_STATIC_RESOLVE = '1';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

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
      await runTransform(root, entryFile, cache, perf.eventEmitter);

      expect(
        perf.events.filter((event) => event.type === 'staticResolve')
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            exported: 'color',
            filename: depFile,
            phase: 'export',
            reason: 'unsupported-expression',
            status: 'rejected',
          }),
        ])
      );
      expect(warnSpy).toHaveBeenCalledWith(
        '[wyw-static-resolve]',
        expect.objectContaining({
          reason: 'unsupported-expression',
          type: 'staticResolve',
        })
      );
    } finally {
      warnSpy.mockRestore();
      if (previousDebug === undefined) {
        delete process.env.WYW_DEBUG_STATIC_RESOLVE;
      } else {
        process.env.WYW_DEBUG_STATIC_RESOLVE = previousDebug;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines safe exports from modules with unrelated unsafe top-level values', async () => {
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
      expect(result.dependencies).toContain(depFile);
      expect(result.code).not.toContain('./unsafe.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to eval when a fixed object is mutated by top-level code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'unsafe.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      depFile,
      dedent`
        const rules = {
          color: 'red',
        };

        function mutate(value) {
          value.color = 'blue';
        }

        mutate(rules);

        export { rules };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { rules } from './unsafe.js';

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
      expect(result.dependencies).toContain('./unsafe.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes statically resolved imports from modules that still need eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const staticFile = join(root, 'tokens.js');
    const dynamicFile = join(root, 'dynamic.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      staticFile,
      dedent`
        const runtimeOnly = (() => {
          throw new Error('static dependency should not be imported during eval');
        })();

        export const color = 'red';
        export { runtimeOnly };
      `
    );
    writeFileSync(
      dynamicFile,
      dedent`
        export const spacing = Date.now();
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { color } from './tokens.js';
        import { spacing } from './dynamic.js';

        export const className = css\`
          color: ${'${color}'};
          margin: ${'${spacing}'};
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
      expect(result.dependencies).toContain(staticFile);
      expect(result.dependencies).toContain('./dynamic.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines imported selector-only processor class names without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const classesFile = join(root, 'classes.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      classesFile,
      dedent`
        import { css } from 'test-css-processor';

        const runtimeOnly = (() => {
          throw new Error('selector-only class should not be imported during eval');
        })();

        export const marker = css\`\`;
        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { marker } from './classes.js';

        export const className = css\`
          .${'${marker}'} {
            color: red;
          }
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
      expect(result.dependencies).toContain(classesFile);
      expect(result.code).not.toContain('./classes.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines namespace selector-only processor class names without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const classesFile = join(root, 'classes.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      classesFile,
      dedent`
        import { css } from 'test-css-processor';

        const runtimeOnly = (() => {
          throw new Error('namespace class should not be imported during eval');
        })();

        export const marker = css\`\`;
        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import * as classes from './classes.js';

        export const className = css\`
          .${'${classes.marker}'} {
            color: red;
          }
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
      expect(result.dependencies).toContain(classesFile);
      expect(result.code).not.toContain('./classes.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps processor class names with CSS rules on the eval path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const classesFile = join(root, 'classes.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      classesFile,
      dedent`
        import { css } from 'test-css-processor';

        export const marker = css\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { marker } from './classes.js';

        export const className = css\`
          .${'${marker}'} {
            color: red;
          }
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
      expect(result.dependencies).toContain('./classes.js');
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

  it('inlines local package styled metadata outside the app root without eval', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const root = join(temp, 'app');
    const sharedRoot = join(temp, 'shared');
    const entryFile = join(root, 'entry.js');
    const baseFile = join(sharedRoot, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    mkdirSync(root, { recursive: true });
    mkdirSync(sharedRoot, { recursive: true });
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
        import { Base } from '../shared/base.js';

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
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata for a local runtime component without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const Runtime = () => null;

        export const Base = styled(Runtime)\`
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

  it('inlines styled metadata for a local React runtime wrapper without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      baseFile,
      dedent`
        import React from 'react';
        import { styled } from 'test-styled-processor';

        const Runtime = React.forwardRef(() => null);

        export const Base = styled(Runtime)\`
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

  it('inlines styled metadata for a direct SVG runtime import without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import SvgIcon from './icon.svg?react';

        export const Base = styled(SvgIcon)\`
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

  it('inlines styled metadata for an SVG runtime import re-exported through a barrel without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const iconsFile = join(root, 'icons.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      iconsFile,
      dedent`
        import SvgIcon from './icon.svg?react';

        export { SvgIcon as Icon };
      `
    );
    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Icon } from './icons.js';

        export const Base = styled(Icon)\`
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
      expect(result.dependencies).toEqual(
        expect.arrayContaining([baseFile, iconsFile])
      );
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prunes static SVG metadata helpers when the file still needs eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const runtimeFile = join(root, 'runtime.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(runtimeFile, `export const makeRuntime = () => null;`);
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import SvgIcon from './icon.svg?react';
        import { makeRuntime } from './runtime.js';

        const RuntimeBase = makeRuntime();

        export const Icon = styled(SvgIcon)\`
          color: red;
        \`;

        export const Dynamic = styled(RuntimeBase)\`
          font-size: 12px;
        \`;
      `
    );

    const resolver = createResolver(processorFile);
    const failOnRuntimeSvgResolve = async (what: string, importer: string) => {
      if (what.includes('.svg?react')) {
        throw new Error(`SVG import reached eval: ${what}`);
      }

      return resolver(what, importer);
    };

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {},
        failOnRuntimeSvgResolve
      );

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('font-size:12px');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata wrapped in local Object.assign without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const Base = styled.div\`
          color: red;
        \`;
        const aliases = {
          Root: Base,
        };

        export default Object.assign(Base, aliases);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Base from './base.js';

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

  it('inlines styled metadata wrapped in Object.assign through a barrel without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const barrelFile = join(root, 'barrel.js');
    const tableFile = join(root, 'table.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      tableFile,
      dedent`
        import { styled } from 'test-styled-processor';

        export const Table = styled.div\`
          color: red;
        \`;
        export const Cell = styled.div\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      barrelFile,
      dedent`
        import { Table, Cell } from './table.js';

        const aliases = {
          Cell,
        };

        export default Object.assign(Table, aliases);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Table from './barrel.js';

        export const Extended = styled(Table)\`
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
      expect(result.dependencies).toEqual(
        expect.arrayContaining([barrelFile, tableFile])
      );
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps non-metadata Object.assign values on the eval path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const depFile = join(root, 'theme.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      depFile,
      dedent`
        const aliases = {
          background: 'blue',
        };

        export const theme = Object.assign({ color: 'red' }, aliases);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { theme } from './theme.js';

        export const className = css\`
          color: ${'${theme.color}'};
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
      expect(result.dependencies).toContain('./theme.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled primitive metadata from a mixed module without eval', async () => {
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

        const runtimeOnly = (() => {
          throw new Error('runtime code should not run while resolving metadata');
        })();

        export const Base = styled.div\`
          color: red;
        \`;

        export { runtimeOnly };
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

  it('inlines transitive styled metadata chains without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const middleFile = join(root, 'middle.js');
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
      middleFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Middle = styled(Base)\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Middle } from './middle.js';

        export const Extended = styled(Middle)\`
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
        /\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\s*\{[^}]*font-size:12px;[^}]*\}/s
      );
      expect(result.dependencies).toEqual(
        expect.arrayContaining([baseFile, middleFile])
      );
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
