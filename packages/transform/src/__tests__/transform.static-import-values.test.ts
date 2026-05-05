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

const runTransformWithOptions = async (
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

const runTransform = async (
  root: string,
  entryFile: string,
  cache: TransformCacheCollection,
  eventEmitter?: EventEmitter,
  pluginOptions: Partial<PluginOptions> = {},
  asyncResolve = createResolver(processorFile)
) =>
  runTransformWithOptions(
    root,
    entryFile,
    cache,
    eventEmitter,
    {
      ...pluginOptions,
      features: {
        staticImportValues: true,
        ...pluginOptions.features,
      },
    },
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

  it('keeps imported static values in eval by default', async () => {
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
      const result = await runTransformWithOptions(
        root,
        entryFile,
        cache,
        perf.eventEmitter
      );

      expect(result.cssText).toContain('color:red');
      expect(result.dependencies).toContain('./tokens.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines compiled TypeScript enum exports without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const statusFile = join(root, 'status.js');
    const levelFile = join(root, 'level.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      statusFile,
      dedent`
        var PowerStatus;
        (function (PowerStatus) {
          PowerStatus["UNKNOWN"] = "unknown";
          PowerStatus["POWERED_ON"] = "powered_on";
        })(PowerStatus || (PowerStatus = {}));
        export { PowerStatus as PowerStatus };
        export default PowerStatus;
      `
    );
    writeFileSync(
      levelFile,
      dedent`
        var Level;
        (function (Level) {
          Level[Level["Low"] = 0] = "Low";
          Level[Level["High"] = 2] = "High";
        })(Level || (Level = {}));
        export default Level;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { PowerStatus } from './status.js';
        import Level from './level.js';

        export const className = css\`
          content: "${'${PowerStatus.UNKNOWN}'}";
          z-index: ${'${Level.High}'};
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

      expect(result.cssText).toContain('content:"unknown"');
      expect(result.cssText).toContain('z-index:2');
      expect(result.dependencies).toContain(statusFile);
      expect(result.dependencies).toContain(levelFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps imported static values in eval when disabled explicitly', async () => {
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

  it('keeps local static values in eval when disabled explicitly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';

        const color = 'red';

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

  it('inlines imported zero-arg helper calls with static return values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const helperFile = join(root, 'helper.js');
    const tokensFile = join(root, 'tokens.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      tokensFile,
      dedent`
        export const sizes = {
          text: {
            fontSize: '18px',
          },
        };
        export const MOBILE = 'screen and (max-width: 768px)';
      `
    );
    writeFileSync(
      helperFile,
      dedent`
        import { MOBILE, sizes } from './tokens.js';

        export const getLabelStyle = () => {
          return \`
            display: flex;
            font-size: ${'${sizes.text.fontSize}'};

            @media ${'${MOBILE}'} {
              display: block;
            }
          \`;
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { getLabelStyle } from './helper.js';

        export const className = css\`
          ${'${getLabelStyle()}'};
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

      expect(result.cssText).toContain('display:flex');
      expect(result.cssText).toContain('font-size:18px');
      expect(result.cssText).toContain('@media screen and (max-width: 768px)');
      expect(result.dependencies).toContain(helperFile);
      expect(result.dependencies).toContain(tokensFile);
      expect(result.code).not.toContain('./helper.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps imported zero-arg helpers in eval for bare function references', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const helperFile = join(root, 'helper.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      helperFile,
      dedent`
        export const getColor = () => 'red';
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { getColor } from './helper.js';

        export const className = css\`
          color: ${'${getColor}'};
        \`;
      `
    );

    try {
      await expect(
        runTransform(root, entryFile, cache, perf.eventEmitter)
      ).rejects.toThrow("css tag cannot handle 'getColor'");
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
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

  it('emits static resolve debug rejection reasons whenever the feature is enabled', async () => {
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
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not emit static resolve debug events when the feature is disabled', async () => {
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
      await runTransformWithOptions(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        { features: { staticImportValues: false } }
      );

      expect(
        perf.events.filter((event) => event.type === 'staticResolve')
      ).toEqual([]);
    } finally {
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

  it('inlines imported processor class names with CSS rules while preserving a side-effect import', async () => {
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
      expect(result.cssText).not.toContain('color:blue');
      expect(result.dependencies).toContain(classesFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps preserved class side-effect imports out of eval runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const classesFile = join(root, 'classes.js');
    const dynamicFile = join(root, 'dynamic.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      classesFile,
      dedent`
        import { css } from 'test-css-processor';

        const runtimeOnly = (() => {
          throw new Error('side-effect class import should not be imported during eval');
        })();

        export const marker = css\`
          color: blue;
        \`;
        export { runtimeOnly };
      `
    );
    writeFileSync(
      dynamicFile,
      dedent`
        export const spacing = \`\${Date.now()}px\`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { marker } from './classes.js';
        import { spacing } from './dynamic.js';

        export const className = css\`
          .${'${marker}'} {
            margin: ${'${spacing}'};
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

      expect(result.cssText).toContain('margin:');
      expect(result.cssText).not.toContain('color:blue');
      expect(result.code).toContain('./classes.js');
      expect(result.dependencies).toContain(classesFile);
      expect(result.dependencies).toContain('./dynamic.js');
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

  it('inlines styled metadata for an imported React runtime wrapper export without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const runtimeFile = join(root, 'runtime.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      runtimeFile,
      dedent`
        import React from 'react';

        const runtimeOnly = (() => {
          throw new Error('runtime wrapper should not be imported during eval');
        })();

        export const Runtime = React.memo(() => null);
        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Runtime } from './runtime.js';

        export const Base = styled(Runtime)\`
          color: red;
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
      expect(result.dependencies).toContain(runtimeFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata for an imported observer runtime wrapper export without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const runtimeFile = join(root, 'runtime.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      runtimeFile,
      dedent`
        import { observer } from 'mobx-react-lite';

        const runtimeOnly = (() => {
          throw new Error('observer wrapper should not be imported during eval');
        })();

        export const Runtime = observer(() => null);
        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Runtime } from './runtime.js';

        export const Base = styled(Runtime)\`
          color: red;
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
      expect(result.dependencies).toContain(runtimeFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata for an imported runtime factory export without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const runtimeFile = join(root, 'runtime.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      runtimeFile,
      dedent`
        import React from 'react';

        const runtimeOnly = (() => {
          throw new Error('runtime factory should not be imported during eval');
        })();

        const createRuntime = (kind) => {
          return React.forwardRef((props, ref) => null);
        };

        export const Runtime = createRuntime('warning');
        export { runtimeOnly };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Runtime } from './runtime.js';

        export const Base = styled(Runtime)\`
          color: red;
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
      expect(result.dependencies).toContain(runtimeFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines nested styled metadata object values with runtime bases without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const runtimeFile = join(root, 'runtime.js');
    const stylesFile = join(root, 'styles.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      runtimeFile,
      dedent`
        const runtimeOnly = (() => {
          throw new Error('nested runtime base should not be imported during eval');
        })();

        export const Button = () => null;
        export { runtimeOnly };
      `
    );
    writeFileSync(
      stylesFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Button } from './runtime.js';

        export const Styles = {
          Primary: styled(Button)\`
            color: red;
          \`,
          Secondary: styled(Button)\`
            color: blue;
          \`,
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { Styles } from './styles.js';

        export const className = css\`
          .${'${Styles.Primary.__wyw_meta.className}'} {
            border-color: red;
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

      expect(result.cssText).toContain('border-color:red');
      expect(result.dependencies).toEqual(
        expect.arrayContaining([runtimeFile, stylesFile])
      );
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata with safe post-declaration Object.assign aliases without eval', async () => {
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
        const Alias = styled.div\`
          color: blue;
        \`;
        const Base = styled(Runtime)\`
          color: red;
        \`;

        Object.assign(Base, { Alias });

        export default Base;
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
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines post-declaration Object.assign alias members without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      baseFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const Infix = styled.span\`
          color: blue;
        \`;
        const Base = styled.div\`
          color: red;
        \`;

        Object.assign(Base, { Infix });

        export default Base;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Base from './base.js';

        export const Extended = styled(Base.Infix)\`
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

  it('keeps unsafe post-declaration styled metadata calls on the eval path', async () => {
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
        const Base = styled(Runtime)\`
          color: red;
        \`;

        function touch(value) {
          return value;
        }

        touch(Base);

        export default Base;
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
      expect(result.dependencies).toContain('./base.js');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines styled metadata for an external runtime namespace primitive without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import * as Tabs from '@radix-ui/react-tabs';

        export const Base = styled(Tabs.Root)\`
          color: red;
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
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps unresolved external runtime primitives outside the allowlist on the eval path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const runtimeFile = join(root, 'runtime-ui.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const defaultResolve = createResolver(processorFile);
    const asyncResolve = async (what: string, importer: string) => {
      if (what === 'runtime-ui') {
        return runtimeFile;
      }

      return defaultResolve(what, importer);
    };

    writeFileSync(
      runtimeFile,
      dedent`
        export const Root = (() => () => null)();
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import * as UI from 'runtime-ui';

        export const Base = styled(UI.Root)\`
          color: red;
        \`;
      `
    );

    try {
      const result = await runTransform(
        root,
        entryFile,
        cache,
        perf.eventEmitter,
        {},
        asyncResolve
      );

      expect(result.cssText).toContain('color:red');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
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

  it('inlines styled metadata from Object.assign alias members without eval', async () => {
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
        export const Row = styled.div\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      barrelFile,
      dedent`
        import { Row, Table } from './table.js';

        const aliases = {
          Row,
        };

        export default Object.assign(Table, aliases);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Table from './barrel.js';

        export const Extended = styled(Table.Row)\`
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

  it('inlines same-module Object.assign alias members without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const panelFile = join(root, 'panel.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      panelFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const aliases = {
          Body: styled.div\`
            color: blue;
          \`,
        };

        const Panel = styled.div\`
          color: red;
        \`;

        export default Object.assign(Panel, aliases);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Panel from './panel.js';

        export const Extended = styled(Panel.Body)\`
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
      expect(result.dependencies).toContain(panelFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines exported Object.assign alias members with opaque local bases without eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const panelFile = join(root, 'panel.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(
      panelFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const RuntimeHeading = () => null;

        export const Heading = styled(RuntimeHeading)\`
          color: blue;
        \`;

        const aliases = {
          Heading,
        };

        const Panel = styled.div\`
          color: red;
        \`;

        export default Object.assign(Panel, aliases);
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import Panel from './panel.js';

        export const Extended = styled(Panel.Heading)\`
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
      expect(result.dependencies).toContain(panelFile);
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

  it('inlines static styled metadata helpers into local styled chains before eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const entryFile = join(root, 'entry.js');
    const flexFile = join(root, 'flex.js');
    const dynamicFile = join(root, 'dynamic.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();

    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    writeFileSync(
      flexFile,
      dedent`
        import { styled } from 'test-styled-processor';

        const runtimeOnly = (() => {
          throw new Error('styled primitive module should not run during eval');
        })();

        export const Horizontal = styled.div\`
          display: flex;
        \`;

        export const Spring = styled.div\`
          flex: 1;
        \`;

        export { runtimeOnly };
      `
    );
    writeFileSync(dynamicFile, `export const spacing = Date.now();`);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { styled } from 'test-styled-processor';
        import { spacing } from './dynamic.js';
        import { Horizontal, Spring } from './flex.js';

        export const Runtime = () => Spring;

        const Row = styled(Horizontal)\`
          color: red;
        \`;

        export const Root = styled(Row)\`
          font-size: 12px;
        \`;

        export const className = css\`
          margin: ${'${spacing}'}px;
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
      expect(result.cssText).toContain('font-size:12px');
      expect(result.dependencies).toContain(flexFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses cached static styled metadata across entry transforms', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const firstEntryFile = join(root, 'entry-a.js');
    const secondEntryFile = join(root, 'entry-b.js');
    const baseFile = join(root, 'base.js');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const asyncResolve = createResolver(processorFile);

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
      firstEntryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `
    );
    writeFileSync(
      secondEntryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Base } from './base.js';

        export const Extended = styled(Base)\`
          font-size: 14px;
        \`;
      `
    );

    try {
      const first = await runTransform(
        root,
        firstEntryFile,
        cache,
        perf.eventEmitter,
        {},
        asyncResolve
      );
      const staticMetadataCount =
        perf.counts.get('transform:preeval:staticMetadata') ?? 0;
      expect(staticMetadataCount).toBeGreaterThan(0);
      const second = await runTransform(
        root,
        secondEntryFile,
        cache,
        perf.eventEmitter,
        {},
        asyncResolve
      );

      expect(first.cssText).toContain('font-size:12px');
      expect(second.cssText).toContain('font-size:14px');
      expect(perf.counts.get('transform:preeval:staticMetadata') ?? 0).toBe(
        staticMetadataCount
      );
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses static metadata preeval for multiple exports from one file', async () => {
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

        export const Accent = styled.div\`
          color: blue;
        \`;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { Accent, Base } from './base.js';

        export const ExtendedBase = styled(Base)\`
          font-size: 12px;
        \`;

        export const ExtendedAccent = styled(Accent)\`
          line-height: 16px;
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
      expect(result.cssText).toContain('line-height:16px');
      expect(result.dependencies).toContain(baseFile);
      expect(perf.counts.get('transform:preeval:staticMetadata') ?? 0).toBe(1);
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

  it('does not produce link errors when a re-export barrel needs exports shaken from a prior eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const tokensFile = join(root, 'tokens.js');
    const barrelFile = join(root, 'barrel.js');
    const entryA = join(root, 'entry-a.js');
    const entryB = join(root, 'entry-b.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      tokensFile,
      dedent`
        export const fontFamily = 'Inter, sans-serif';
        export const textStyles = { fontSize: '14px', lineHeight: '1.5' };
      `
    );
    writeFileSync(
      barrelFile,
      dedent`
        export { fontFamily } from './tokens.js';
      `
    );
    writeFileSync(
      entryA,
      dedent`
        import { css } from 'test-css-processor';
        import { textStyles } from './tokens.js';

        export const className = css\`
          font-size: ${'${textStyles.fontSize}'};
        \`;
      `
    );
    writeFileSync(
      entryB,
      dedent`
        import { css } from 'test-css-processor';
        import { fontFamily } from './barrel.js';

        export const className = css\`
          font-family: ${'${fontFamily}'};
        \`;
      `
    );

    try {
      // entry-a caches tokens.js with only=['textStyles'] (fontFamily shaken out)
      const resultA = await runTransform(root, entryA, cache);
      expect(resultA.cssText).toContain('font-size:14px');

      // entry-b needs fontFamily from tokens.js via barrel.js re-export.
      // The broker/runner must not serve a shaken variant that omits fontFamily.
      const resultB = await runTransform(root, entryB, cache);
      expect(resultB.cssText).toContain('font-family:Inter,sans-serif');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('survives concurrent transforms that need different exports from the same module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const tokensFile = join(root, 'tokens.js');
    const barrelFile = join(root, 'barrel.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      tokensFile,
      dedent`
        export const fontFamily = 'Inter, sans-serif';
        export const fontWeight = { light: 300, regular: 400, bold: 700 };
        export const textStyles = { fontSize: '14px', lineHeight: '1.5' };
      `
    );
    writeFileSync(
      barrelFile,
      dedent`
        export { fontFamily, fontWeight } from './tokens.js';
      `
    );

    // Create N entry files: half import textStyles directly, half import
    // fontFamily via barrel.  Run all transforms concurrently (like webpack).
    const N = 10;
    const entries: string[] = [];
    for (let i = 0; i < N; i++) {
      const entryFile = join(root, `entry-${i}.js`);
      if (i % 2 === 0) {
        writeFileSync(
          entryFile,
          dedent`
            import { css } from 'test-css-processor';
            import { textStyles } from './tokens.js';

            export const className = css\`
              font-size: ${'${textStyles.fontSize}'};
            \`;
          `
        );
      } else {
        writeFileSync(
          entryFile,
          dedent`
            import { css } from 'test-css-processor';
            import { fontFamily } from './barrel.js';

            export const className = css\`
              font-family: ${'${fontFamily}'};
            \`;
          `
        );
      }
      entries.push(entryFile);
    }

    try {
      // Run all transforms concurrently, sharing the same cache.
      const results = await Promise.all(
        entries.map((entry) => runTransform(root, entry, cache))
      );

      for (let i = 0; i < N; i++) {
        if (i % 2 === 0) {
          expect(results[i].cssText).toContain('font-size:14px');
        } else {
          expect(results[i].cssText).toContain('font-family:Inter,sans-serif');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not produce link errors when the same module is imported directly and via barrel with different exports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-import-'));
    const tokensFile = join(root, 'tokens.js');
    const barrelFile = join(root, 'barrel.js');
    const entryFile = join(root, 'entry.js');
    const cache = new TransformCacheCollection();

    writeFileSync(
      tokensFile,
      dedent`
        export const fontFamily = 'Inter, sans-serif';
        export const fontWeight = { light: 300, regular: 400, bold: 700 };
        export const textStyles = { fontSize: '14px', lineHeight: '1.5' };
      `
    );
    writeFileSync(
      barrelFile,
      dedent`
        export { fontFamily, fontWeight } from './tokens.js';
      `
    );
    // Single entry that imports textStyles directly from tokens
    // AND fontFamily via the barrel — within one eval, the runner loads
    // tokens.js once for the direct import (only=['textStyles']) and once
    // during barrel.js linking (needs fontFamily+fontWeight).
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { textStyles } from './tokens.js';
        import { fontFamily, fontWeight } from './barrel.js';

        export const className = css\`
          font-size: ${'${textStyles.fontSize}'};
          font-family: ${'${fontFamily}'};
          font-weight: ${'${fontWeight.regular}'};
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, cache);
      expect(result.cssText).toContain('font-size:14px');
      expect(result.cssText).toContain('font-family:Inter,sans-serif');
      expect(result.cssText).toContain('font-weight:400');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
