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
        export { fontWeight, textStyles } from './design-system/typography';
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

  it('retries cold aliased sibling package barrel child imports before eval fallback', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'wyw-ds-alias-repro-'));
    const appRoot = join(workspaceRoot, 'app');
    const appSrc = join(appRoot, 'src', 'components', 'app');
    const packageRoot = join(workspaceRoot, 'packages', 'ui-kit', 'src');
    const dsDir = join(packageRoot, 'design-system');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(appSrc, 'not-found-page.tsx');

    require('fs').mkdirSync(appSrc, { recursive: true });
    require('fs').mkdirSync(dsDir, { recursive: true });
    const { barrelFile, themeFile, typographyFile } =
      writeBarrelChain(packageRoot);
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { fontWeight, themeVars } from '@pkg/ui-kit/src/design-system';

        export const inlineButton = css\`
          font-weight: ${'${fontWeight.semibold}'};
        \`;

        export const notFoundPageStyle = css\`
          ${'${'}{
            width: '100vw',
            height: '100%',
            backgroundColor: themeVars.accentTextColor,
            color: themeVars.textColor,
            display: 'flex',
            flexDirection: 'column',
          }${'}'}
        \`;
      `
    );

    const resolveRelative = (what: string, importer: string) => {
      const base = resolve(dirname(importer), what);
      for (const ext of ['.ts', '.tsx', '.js']) {
        const candidate = `${base}${ext}`;
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      }
      return base;
    };

    const coldMisses = new Set([
      './design-system/theme',
      './design-system/typography',
    ]);
    const resolver = async (what: string, importer: string) => {
      if (what === 'test-css-processor') {
        return processorFile;
      }

      if (what === '@pkg/ui-kit/src/design-system') {
        return barrelFile;
      }

      if (what.startsWith('.')) {
        if (importer.endsWith('design-system.ts') && coldMisses.delete(what)) {
          return null;
        }

        // Real webpack-style resolvers receive absolute importer ids. The
        // static resolver currently asks for barrel children before the
        // sibling package entrypoint is fully rooted, which reproduces the
        // bench's candidate-import-unresolved cascade.
        return importer.startsWith(workspaceRoot)
          ? resolveRelative(what, importer)
          : null;
      }

      return null;
    };

    try {
      const result = await transform(
        {
          cache,
          eventEmitter: perf.eventEmitter,
          options: {
            filename: entryFile,
            root: appRoot,
            pluginOptions: {
              configFile: false,
              features: { staticImportValues: true },
              tagResolver: (source, tag) =>
                source === 'test-css-processor' && tag === 'css'
                  ? processorFile
                  : null,
            },
          },
        },
        readFileSync(entryFile, 'utf8'),
        resolver
      );

      const candidateEvents = collectStaticResolveEvents(perf.events).filter(
        (event) =>
          event.phase === 'candidate' &&
          (event.candidate === '_exp' || event.candidate === '_exp2')
      );

      expect({
        cssText: result.cssText,
        candidateEvents,
        evals: perf.counts.get('transform:evalFile') ?? 0,
      }).toEqual(
        expect.objectContaining({
          evals: 0,
        })
      );
      expect(candidateEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ candidate: '_exp', status: 'resolved' }),
          expect.objectContaining({ candidate: '_exp2', status: 'resolved' }),
        ])
      );
      expect(result.cssText).toContain('font-weight:600');
      expect(result.cssText).toContain(
        'background-color:var(--fibery-color-accentTextColor)'
      );
      expect(result.cssText).toContain('color:var(--fibery-color-textColor)');
      expect(result.code).not.toContain('@pkg/ui-kit/src/design-system');
      expect([themeFile, typographyFile]).toEqual([
        expect.stringContaining('theme.ts'),
        expect.stringContaining('typography.ts'),
      ]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

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

  it('inlines binary numeric expressions (-, *, /, %, **) over imported tokens', async () => {
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
          padding-top: ${'${space.s12 - space.s6}'}px;
          padding-right: ${'${space.s12 / 2}'}px;
          padding-bottom: ${'${space.s12 % 5}'}px;
          padding-left: ${'${space.s12 * 2}'}px;
          margin-top: ${'${space.s6 ** 2}'}px;
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
      expect(result.cssText).toContain('padding-top:6px');
      expect(result.cssText).toContain('padding-right:6px');
      expect(result.cssText).toContain('padding-bottom:2px');
      expect(result.cssText).toContain('padding-left:24px');
      expect(result.cssText).toContain('margin-top:36px');
      expect(result.code).not.toContain('./design-system');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines inline ObjectExpression candidates (style={{...}}) with binary/unary/spread', async () => {
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
        import { space, textStyles } from './design-system';

        export const className = css\`
          ${'${{ height: space.s12 + 1, width: space.s12 - 2, margin: -space.s6, padding: (24 - space.s12) / 2 }}'};
          ${'${{ ...textStyles.heading6, padding: space.s12 }}'};
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
      expect(result.cssText).toContain('height:13'); // space.s12 + 1
      expect(result.cssText).toContain('width:10'); // space.s12 - 2
      expect(result.cssText).toContain('margin:-6'); // -space.s6
      expect(result.cssText).toContain('padding:6'); // (24 - 12) / 2
      expect(result.cssText).toContain('font-size:12'); // ...textStyles.heading6
      expect(result.code).not.toContain('./design-system');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines process.env.X || fallback by treating process.env.X as undefined', async () => {
    // Ensure the test env var is unrelated to whatever the build machine has.
    // The contract is that process.env.X is always undefined at build time —
    // setting it should not affect the inlined value.
    process.env.WYW_TEST_PREFIX = 'should-be-ignored';

    const root = mkdtempSync(join(tmpdir(), 'wyw-ds-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'entry.tsx');
    const tokensFile = join(root, 'tokens.ts');

    writeFileSync(
      tokensFile,
      `export const varPrefix = process.env.WYW_TEST_PREFIX || 'fibery';\n`
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { varPrefix } from './tokens';

        export const className = css\`
          --prefix: ${'${varPrefix}'};
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
      expect(result.cssText).toContain('--prefix:fibery');
      expect(result.cssText).not.toContain('should-be-ignored');
      expect(result.code).not.toContain('./tokens');
    } finally {
      delete process.env.WYW_TEST_PREFIX;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines an exported ObjectExpression with template literal values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-ds-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'entry.tsx');
    const tokensFile = join(root, 'tokens.ts');

    writeFileSync(
      tokensFile,
      dedent`
        export const themeVars = {
          surface: 'var(--surface)',
          border: 'var(--border)',
        };

        export const shadows = {
          card: \`0 0 0 1px ${'${themeVars.border}'}\`,
          panel: \`0 4px 16px ${'${themeVars.surface}'}\`,
        } as const;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { shadows } from './tokens';

        export const className = css\`
          box-shadow: ${'${shadows.card}'};
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
      expect(result.cssText).toContain('box-shadow:0 0 0 1px var(--border)');
      expect(result.code).not.toContain('./tokens');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not poison staticExportCache across transforms when the resolver fails once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-ds-repro-'));
    const dsDir = join(root, 'design-system');
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const firstEntry = join(root, 'first.tsx');
    const secondEntry = join(root, 'second.tsx');

    require('fs').mkdirSync(dsDir, { recursive: true });
    writeBarrelChain(root);
    writeFileSync(
      firstEntry,
      dedent`
        import { css } from 'test-css-processor';
        import { themeVars } from './design-system';

        export const a = css\` color: ${'${themeVars.accentTextColor}'}; \`;
      `
    );
    writeFileSync(
      secondEntry,
      dedent`
        import { css } from 'test-css-processor';
        import { themeVars } from './design-system';

        export const b = css\` background: ${'${themeVars.textColor}'}; \`;
      `
    );

    // Track resolver calls. The bounded retry should re-call once after a
    // transient failure but cap retries — never thunder-herd.
    const baseResolver = createResolver(processorFile);
    let calls = 0;
    let trippedThemeFailure = false;
    const resolver = async (what: string, importer: string) => {
      calls += 1;
      if (
        what === './design-system/theme' &&
        importer.endsWith('design-system.ts') &&
        !trippedThemeFailure
      ) {
        trippedThemeFailure = true;
        throw new Error('transient resolver failure');
      }
      return baseResolver(what, importer);
    };

    const runOne = (entryFile: string) =>
      transform(
        {
          cache,
          eventEmitter: perf.eventEmitter,
          options: {
            filename: entryFile,
            root,
            pluginOptions: {
              configFile: false,
              features: { staticImportValues: true },
              tagResolver: (source, tag) =>
                source === 'test-css-processor' && tag === 'css'
                  ? processorFile
                  : null,
            },
          },
        },
        readFileSync(entryFile, 'utf8'),
        resolver
      );

    try {
      await runOne(firstEntry);
      const eventsAfterFirst = perf.events.length;
      const callsAfterFirst = calls;
      const secondResult = await runOne(secondEntry);

      // Second transform should inline cleanly — no cached null poisoning it.
      const secondEvents = perf.events.slice(eventsAfterFirst);
      const secondResolveEvents = secondEvents.filter(
        (event): event is StaticResolveEvent => event.type === 'staticResolve'
      );
      const secondCascades = secondResolveEvents.filter(
        (event) =>
          event.status === 'rejected' &&
          (event.reason === 'resolve-failed' ||
            event.reason === 'candidate-import-unresolved')
      );
      expect({
        cssText: secondResult.cssText,
        cascades: secondCascades,
      }).toEqual(
        expect.objectContaining({
          cascades: [],
        })
      );
      expect(secondResult.cssText).toContain(
        'background:var(--fibery-color-textColor)'
      );

      // Bounded: total resolver calls should NOT scale linearly with consumers.
      // We measure by checking that the second transform's calls are bounded
      // (a few extra for fresh imports + at most one bounded retry).
      const secondTransformCalls = calls - callsAfterFirst;
      expect(secondTransformCalls).toBeLessThan(20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines logical / conditional / unary expressions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-ds-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'entry.tsx');
    const tokensFile = join(root, 'tokens.ts');

    writeFileSync(
      tokensFile,
      dedent`
        export const empty = null;
        export const fallback = 'fallback';
        export const flag = true;
        export const yes = 'yes';
        export const no = 'no';
        export const offset = 12;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { empty, fallback, flag, yes, no, offset } from './tokens';

        export const className = css\`
          --logical: ${'${empty || fallback}'};
          --nullish: ${'${empty ?? fallback}'};
          --conditional: ${'${flag ? yes : no}'};
          --neg: ${'${-offset}'}px;
          --pos: ${'${+offset}'}px;
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
      expect(result.cssText).toContain('--logical:fallback');
      expect(result.cssText).toContain('--nullish:fallback');
      expect(result.cssText).toContain('--conditional:yes');
      expect(result.cssText).toContain('--neg:-12px');
      expect(result.cssText).toContain('--pos:12px');
      expect(result.code).not.toContain('./tokens');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
