import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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

const createResolver =
  (processorPath: string) => async (what: string, importer: string) => {
    if (what === 'test-css-processor') {
      return processorPath;
    }

    if (what.startsWith('.')) {
      const base = resolve(dirname(importer), what);
      for (const ext of ['.ts', '.tsx', '.js']) {
        const candidate = `${base}${ext}`;
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      }
      for (const ext of ['/index.ts', '/index.tsx', '/index.js']) {
        const candidate = `${base}${ext}`;
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      }
      return base;
    }

    return null;
  };

const createPerfEventRecorder = () => {
  const events: Record<string, unknown>[] = [];
  const eventEmitter = new EventEmitter(
    (labels, type) => {
      if (type === 'single') {
        events.push(labels);
      }
    },
    () => 0,
    () => {}
  );

  return { eventEmitter, events };
};

const runTransform = async (
  root: string,
  entryFile: string,
  cache: TransformCacheCollection,
  eventEmitter: EventEmitter,
  pluginOptions: Partial<PluginOptions> = {}
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
          features: {
            staticImportValues: true,
            ...pluginOptions.features,
          },
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

type StaticResolveEvent = {
  candidate?: string;
  exported?: string;
  filename?: string;
  imported?: string;
  phase?: string;
  reason?: string;
  source?: string;
  status?: string;
  type?: string;
};

const collectStaticResolveEvents = (
  events: Record<string, unknown>[]
): StaticResolveEvent[] =>
  events.filter(
    (event): event is StaticResolveEvent => event.type === 'staticResolve'
  );

describe('design-system chain repro for staticImportValues', () => {
  const previousDebug = process.env.WYW_DEBUG_STATIC_RESOLVE;

  beforeAll(() => {
    process.env.WYW_DEBUG_STATIC_RESOLVE = '1';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(() => {
    if (previousDebug === undefined) {
      delete process.env.WYW_DEBUG_STATIC_RESOLVE;
    } else {
      process.env.WYW_DEBUG_STATIC_RESOLVE = previousDebug;
    }
    jest.restoreAllMocks();
  });

  const writeBarrelChain = (root: string) => {
    const barrelFile = join(root, 'design-system.ts');
    const layoutFile = join(root, 'design-system', 'layout.ts');
    const themeFile = join(root, 'design-system', 'theme.ts');
    const typographyFile = join(root, 'design-system', 'typography.ts');

    writeFileSync(
      barrelFile,
      dedent`
        export { space } from './design-system/layout';
        export { themeVars } from './design-system/theme';
        export { textStyles } from './design-system/typography';
      `
    );

    writeFileSync(
      layoutFile,
      dedent`
        export const space = {
          s0: 0,
          s6: 6,
          s12: 12,
        } as const;
      `
    );

    writeFileSync(
      themeFile,
      dedent`
        function memoize(fn, _key) {
          return fn;
        }
        function themeFromPaletteImpl(palette, mode) {
          return { palette, mode };
        }

        export const themeFromPalette = memoize(themeFromPaletteImpl, (palette, mode) => palette + mode);
        themeFromPalette.cache = { max: 4 };

        export const themeVars = {
          accentTextColor: 'var(--fibery-color-accentTextColor)',
          textColor: 'var(--fibery-color-textColor)',
        };
      `
    );

    writeFileSync(
      typographyFile,
      dedent`
        import { themeVars } from './theme';

        export const lineHeight = {
          heading: 1.3,
        } as const;

        export const fontWeight = {
          regular: 410,
          semibold: 600,
        } as const;

        export const typeSizes = [30, 24, 18, 16, 14, 12] as const;

        export const fontFamily = '"Inter Variable", sans-serif';

        export const textStyles = {
          heading6: {
            fontFamily,
            fontSize: typeSizes[5],
            lineHeight: lineHeight.heading,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            fontWeight: fontWeight.regular,
            color: themeVars.textColor,
          },
        };
      `
    );

    return { barrelFile, layoutFile, themeFile, typographyFile };
  };

  it('inlines space.s12 + space.s6 (literal-only object via barrel)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-ds-repro-'));
    const dsDir = join(root, 'design-system');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'entry.tsx');

    require('fs').mkdirSync(dsDir, { recursive: true });
    writeBarrelChain(root);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { space } from './design-system';

        export const className = css\`
          padding: ${'${space.s12 + space.s6}'}px;
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

      const rejections = collectStaticResolveEvents(perf.events).filter(
        (event) => event.status === 'rejected'
      );
      // surface rejection reasons in the assertion error
      expect({ cssText: result.cssText, rejections }).toEqual(
        expect.objectContaining({ rejections: [] })
      );
      expect(result.cssText).toContain('padding:18px');
      expect(result.code).not.toContain('./design-system');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines themeVars.accentTextColor (literal object in module with top-level mutation)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-ds-repro-'));
    const dsDir = join(root, 'design-system');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'entry.tsx');

    require('fs').mkdirSync(dsDir, { recursive: true });
    writeBarrelChain(root);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { themeVars } from './design-system';

        export const className = css\`
          color: ${'${themeVars.accentTextColor}'};
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

      const rejections = collectStaticResolveEvents(perf.events).filter(
        (event) => event.status === 'rejected'
      );
      expect({ cssText: result.cssText, rejections }).toEqual(
        expect.objectContaining({ rejections: [] })
      );
      expect(result.cssText).toContain(
        'color:var(--fibery-color-accentTextColor)'
      );
      expect(result.code).not.toContain('./design-system');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines textStyles.heading6 (object whose values reference another static import)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-ds-repro-'));
    const dsDir = join(root, 'design-system');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'entry.tsx');

    require('fs').mkdirSync(dsDir, { recursive: true });
    writeBarrelChain(root);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { textStyles } from './design-system';

        export const className = css\`
          ${'${textStyles.heading6}'};
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

      const rejections = collectStaticResolveEvents(perf.events).filter(
        (event) => event.status === 'rejected'
      );
      expect({ cssText: result.cssText, rejections }).toEqual(
        expect.objectContaining({ rejections: [] })
      );
      expect(result.cssText).toContain('font-size:12');
      expect(result.cssText).toContain('color:var(--fibery-color-textColor)');
      expect(result.code).not.toContain('./design-system');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
