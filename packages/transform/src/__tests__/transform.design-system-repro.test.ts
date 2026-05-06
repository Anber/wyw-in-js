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

  it('inlines same-file const-of-const object spread referenced from css', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'entry.tsx');

    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';

        const base = { fontSize: 12, color: 'red' };
        const extended = { ...base, padding: 4 };

        export const className = css\`
          ${'${extended}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('font-size:12');
      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('padding:4');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines chained same-file const spreads (a -> b -> c)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'entry.tsx');

    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';

        const a = { fontSize: 12 };
        const b = { ...a, color: 'red' };
        const c = { ...b, padding: 4 };

        export const className = css\`
          ${'${c}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('font-size:12');
      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('padding:4');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines top-level const that spreads imported member access', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
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
        import { textStyles, space } from './design-system';

        const local = { ...textStyles.heading6, padding: space.s12 };

        export const className = css\`
          ${'${local}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('font-size:12');
      expect(result.cssText).toContain('color:var(--fibery-color-textColor)');
      expect(result.cssText).toContain('padding:12');
      expect(result.code).not.toContain('./design-system');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines spread of bare imported binding (no member access)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'entry.tsx');
    const tokensFile = join(root, 'tokens.ts');

    writeFileSync(
      tokensFile,
      dedent`
        export const tabularNumsOn = {
          fontVariantNumeric: 'tabular-nums',
          fontFeatureSettings: '"tnum" 1',
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { tabularNumsOn } from './tokens';

        const numericRow = { ...tabularNumsOn, fontSize: 14 };

        export const className = css\`
          ${'${numericRow}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('font-variant-numeric:tabular-nums');
      expect(result.cssText).toContain('font-size:14');
      expect(result.code).not.toContain('./tokens');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines spread inside a nested object property (deep css selector)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
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
        import { textStyles, space } from './design-system';

        const htmlStyles = {
          fontSize: 16,
          '& ul': {
            margin: space.s6,
            ...textStyles.heading6,
          },
        };

        export const className = css\`
          ${'${htmlStyles}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain(' ul{');
      expect(result.cssText).toContain('margin:6');
      expect(result.cssText).toContain('font-size:12');
      expect(result.code).not.toContain('./design-system');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines same-file css class name used as computed key inside object interp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'entry.tsx');

    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';

        const pageCss = css\`\`;

        export const printOnly = css\`
          ${'${{'} '@media print': {
            [\`.${'${pageCss}'}.${'${pageCss}'}\`]: {
              appearance: 'none',
            },
          } ${'}}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('@media print');
      expect(result.cssText).toContain('appearance:none');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines two-level same-file consts that spread imported tokens (antd input pattern)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const antdDir = join(root, 'antd');
    const dsDir = join(root, 'design-system');
    const entryFile = join(antdDir, 'styles.ts');
    const dsBarrel = join(root, 'design-system.ts');

    require('fs').mkdirSync(antdDir, { recursive: true });
    require('fs').mkdirSync(dsDir, { recursive: true });

    writeFileSync(
      dsBarrel,
      dedent`
        export { space, border, layout, transition } from './design-system/layout';
        export { textStyles } from './design-system/typography';
        export { themeVars, shadows } from './design-system/theme';
      `
    );
    writeFileSync(
      join(dsDir, 'layout.ts'),
      dedent`
        export const space = { s4: 4, s6: 6, s8: 8, s12: 12, s24: 24 } as const;
        export const border = { radius6: 6 } as const;
        export const layout = { inputHeight: 32 } as const;
        export const transition = '160ms ease' as const;
      `
    );
    writeFileSync(
      join(dsDir, 'typography.ts'),
      dedent`
        export const textStyles = {
          regular: { fontSize: 14, color: 'var(--text)' },
        };
      `
    );
    writeFileSync(
      join(dsDir, 'theme.ts'),
      dedent`
        export const themeVars = {
          textColor: 'var(--text)',
          accentTextColor: 'var(--accent-text)',
          inputBgColor: 'var(--input-bg)',
          inputBorderColor: 'var(--input-border)',
          inputBorderWarningColor: 'var(--input-border-warning)',
          inputDisabledBgColor: 'var(--input-disabled-bg)',
          inputDisabledBorderColor: 'var(--input-disabled-border)',
          inputPlaceholderTextColor: 'var(--input-placeholder)',
          colorAccentStroke: 'var(--accent-stroke)',
          colorAccentStrokeHover: 'var(--accent-stroke-hover)',
          colorAccentStrokeFocus: 'var(--accent-stroke-focus)',
          transparent: 'transparent',
          warning: 'var(--warning)',
        };
        export const shadows = { border: '0 0 0 1px var(--shadow-border)' } as const;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { border, layout, shadows, space, textStyles, themeVars, transition } from '../design-system';

        const inputVariables = {
          default: {
            '--input-border': \`${'${themeVars.inputBorderColor}'} inset\`,
            '--input-hover-border': \`0 0 0 1px ${'${themeVars.colorAccentStrokeHover}'} inset\`,
            '--input-focus-border': \`0 0 0 1px ${'${themeVars.colorAccentStrokeFocus}'} inset\`,
            '--input-focus-shadow': \`0 0 0 2px ${'${themeVars.colorAccentStroke}'}\`,
          },
          error: {
            '--input-border': \`${'${themeVars.inputBorderWarningColor}'} inset\`,
            '--input-focus-shadow': \`0 0 0 2px ${'${themeVars.warning}'}\`,
          },
        };

        export const inputOverrides = {
          main: {
            ...inputVariables.default,
            font: 'inherit',
            color: themeVars.textColor,
            outline: 'none',
            backgroundColor: \`${'${themeVars.inputBgColor}'} !important\`,
            borderRadius: border.radius6,
            minHeight: layout.inputHeight,
            paddingLeft: space.s12,
            paddingRight: space.s12,
            border: 0,
            borderColor: themeVars.transparent,
            transition: \`box-shadow ${'${transition}'}\`,
            boxShadow: \`var(--input-border, ${'${themeVars.inputBorderColor}'})\`,
            letterSpacing: 0,
            '&::placeholder': { color: themeVars.inputPlaceholderTextColor },
          },
          hover: {
            boxShadow: \`var(--input-hover-border, 0 0 0 1px ${'${themeVars.colorAccentStrokeHover}'}) !important\`,
            transition: \`box-shadow ${'${transition}'}\`,
          },
          focus: {
            boxShadow: \`var(--input-focus-border, 0 0 0 1px ${'${themeVars.colorAccentStroke}'}), var(--input-focus-shadow) !important\`,
            transition: \`box-shadow ${'${transition}'}\`,
          },
          disabled: {
            color: \`${'${themeVars.textColor}'}\`,
            backgroundColor: \`${'${themeVars.inputDisabledBgColor}'} !important\`,
            borderColor: themeVars.transparent,
            boxShadow: \`${'${themeVars.inputDisabledBorderColor}'} !important\`,
            transition: \`box-shadow ${'${transition}'}\`,
            cursor: 'default',
            '&:hover': { boxShadow: \`${'${themeVars.inputDisabledBorderColor}'}\` },
          },
        };

        export const inputStyles = css\`
          & .ant-input-prefix { margin-right: -24px; }
          ${'${{'}
            ...textStyles.regular,
            '& .ant-input-group-addon': {
              backgroundColor: themeVars.transparent,
              boxShadow: shadows.border,
              '&:hover': inputOverrides.hover,
              '&:focus': inputOverrides.focus,
            },
            '& .ant-input-group': { borderSpacing: 1, ...textStyles.regular },
            '& .ant-input': inputOverrides.main,
            '& .ant-input-status-error': inputVariables.error,
            '& .ant-input[readonly]': { ...inputOverrides.disabled, cursor: 'inherit' },
            '& .ant-cascader-picker:focus': inputOverrides.focus,
            '& textarea.ant-input': { paddingTop: space.s8, paddingBottom: space.s8 },
            '&& input:hover': inputOverrides.hover,
            '&& input:focus': inputOverrides.focus,
            '&& .ant-input-disabled': inputOverrides.disabled,
            '& .ant-input-affix-wrapper .ant-input:not(:first-child)': {
              paddingLeft: space.s6 + space.s24 + space.s8,
            },
          ${'}}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('--input-border');
      expect(result.cssText).toContain('padding-left:38');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves cross-file imported const that spreads non-exported sibling const', async () => {
    // date-picker/styles.ts pattern: imports inputOverrides from antd/styles.ts;
    // inputOverrides.main spreads non-exported sibling inputVariables.default.
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'date-picker.ts');
    const antdFile = join(root, 'antd-styles.ts');
    const dsFile = join(root, 'design-system.ts');

    writeFileSync(
      dsFile,
      dedent`
        export const space = { s12: 12 } as const;
        export const themeVars = {
          textColor: 'var(--text)',
          inputBgColor: 'var(--input-bg)',
          inputBorderColor: 'var(--input-border)',
        };
      `
    );

    writeFileSync(
      antdFile,
      dedent`
        import { space, themeVars } from './design-system';

        const inputVariables = {
          default: {
            '--input-border': \`${'${themeVars.inputBorderColor}'} inset\`,
          },
        };

        export const inputOverrides = {
          main: {
            ...inputVariables.default,
            color: themeVars.textColor,
            paddingLeft: space.s12,
          },
          focus: {
            boxShadow: \`var(--input-focus, 0 0 0 1px ${'${themeVars.textColor}'})\`,
          },
        };
      `
    );

    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { inputOverrides } from './antd-styles';

        export const fakeDateInputStyle = css\`
          ${'${{'} ...inputOverrides.main, display: 'flex' ${'}}'};
        \`;
        export const activeClassName = css\`
          ${'${{'} '&:focus': inputOverrides.focus ${'}}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('--input-border:var(--input-border) inset');
      expect(result.cssText).toContain('color:var(--text)');
      expect(result.cssText).toContain('padding-left:12');
      expect(result.cssText).toContain('display:flex');
      expect(result.cssText).toContain(':focus{box-shadow:var(--input-focus');
      expect(result.code).not.toContain('./antd-styles');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a static export from a module that also has non-static sibling exports', async () => {
    // colors-css.ts pattern: shadows is a literal object, but a sibling
    // const dropCursorColor = themeVarWithAlpha(...) is a call expression.
    // Static resolution of shadows must not be poisoned by the non-static
    // sibling.
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'entry.ts');
    const tokensFile = join(root, 'tokens.ts');

    writeFileSync(
      tokensFile,
      dedent`
        export const themeVars = {
          colorShadowBorder: 'var(--shadow-border)',
          colorAccent: 'var(--accent)',
        };

        function themeVarWithAlpha(themeVar, alpha) {
          return \`color-mix(in srgb, ${'${themeVar}'} ${'${alpha * 100}'}%, transparent)\`;
        }

        // Non-static sibling: must not poison resolution of shadows below.
        export const dropCursorColor = themeVarWithAlpha(themeVars.colorAccent, 0.7);

        export const shadows = {
          border: \`0 0 0 1px ${'${themeVars.colorShadowBorder}'}\`,
        } as const;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { shadows } from './tokens';

        export const className = css\`
          ${'${{'} boxShadow: shadows.border ${'}}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain(
        'box-shadow:0 0 0 1px var(--shadow-border)'
      );
      expect(result.code).not.toContain('./tokens');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines static export while leaving dynamic sibling for eval (partial-dynamic module)', async () => {
    // Same module exports a literal-object (shadows) and a CallExpression-init
    // (dropCursorColor). A consumer that uses ONLY the static export must
    // inline without falling back; a consumer that uses the dynamic export
    // is allowed to fall back to evalFile.
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const tokensFile = join(root, 'tokens.ts');
    const staticEntry = join(root, 'static-entry.ts');
    const dynamicEntry = join(root, 'dynamic-entry.ts');

    writeFileSync(
      tokensFile,
      dedent`
        export const themeVars = {
          colorShadowBorder: 'var(--shadow-border)',
          colorAccent: 'var(--accent)',
        };

        function themeVarWithAlpha(themeVar, alpha) {
          return \`color-mix(in srgb, ${'${themeVar}'} ${'${alpha * 100}'}%, transparent)\`;
        }

        export const dropCursorColor = themeVarWithAlpha(themeVars.colorAccent, 0.7);

        export const shadows = {
          border: \`0 0 0 1px ${'${themeVars.colorShadowBorder}'}\`,
        } as const;
      `
    );

    writeFileSync(
      staticEntry,
      dedent`
        import { css } from 'test-css-processor';
        import { shadows } from './tokens';

        export const className = css\`
          ${'${{'} boxShadow: shadows.border ${'}}'};
        \`;
      `
    );

    writeFileSync(
      dynamicEntry,
      dedent`
        import { css } from 'test-css-processor';
        import { dropCursorColor } from './tokens';

        export const className = css\`
          ${'${{'} caretColor: dropCursorColor ${'}}'};
        \`;
      `
    );

    try {
      // Static-only consumer: must inline cleanly, no eval.
      const staticResult = await runTransform(
        root,
        staticEntry,
        cache,
        perf.eventEmitter
      );
      const evalsAfterStatic = perf.counts.get('transform:evalFile') ?? 0;

      expect(staticResult.cssText).toContain(
        'box-shadow:0 0 0 1px var(--shadow-border)'
      );
      expect(evalsAfterStatic).toBe(0);
      expect(staticResult.code).not.toContain('./tokens');

      // Dynamic-only consumer: dropCursorColor is a CallExpression, so
      // the resolver legitimately cannot fold it. Eval may run, but the
      // earlier static-entry transform must NOT have poisoned the cache.
      const dynamicResult = await runTransform(
        root,
        dynamicEntry,
        cache,
        perf.eventEmitter
      );

      // Either inlined to the computed string OR left as a runtime ref —
      // both are acceptable; what matters is that the previous static
      // resolution wasn't poisoned and the dynamic one didn't crash.
      expect(typeof dynamicResult.cssText).toBe('string');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines cross-file css class name interpolated as a bare identifier', async () => {
    // search-on-view.tsx pattern: another file exports a css\`\` class name,
    // a consumer interpolates it directly as ${searchInputClassName} or
    // uses it as a value in an object interp. Should inline to the
    // generated class-name string without falling back to evalFile.
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const sourceFile = join(root, 'search-on-view.tsx');
    const entryFile = join(root, 'view-panel.tsx');

    const mobileFile = join(root, 'mobile-styles.ts');
    writeFileSync(
      mobileFile,
      dedent`
        export const mobileRootSelector = '.mobile-root';
      `
    );
    writeFileSync(
      sourceFile,
      dedent`
        import { css } from 'test-css-processor';
        import { mobileRootSelector } from './mobile-styles';

        export const searchInputClassName = css\`
          ${'${mobileRootSelector}'} & .ant-input-prefix { margin-right: 6px; }
          ${'${mobileRootSelector}'} & .ant-input { font-size: 16px; }
        \`;

        export function SearchOnView() {
          const value = Math.random();
          return value > 0.5 ? 'a' : 'b';
        }
      `
    );

    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { searchInputClassName } from './search-on-view';

        export const panelClassName = css\`
          .${'${searchInputClassName}'} {
            background: blue;
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      // The compiled selector for the consumer must reference the source
      // module's generated class name as a literal, not a runtime ref.
      expect(result.cssText).toContain('background:blue');
      expect(result.cssText).toMatch(/\.s\w+\s*\{/);
      // Side-effect import is OK (so the source module's CSS still
      // registers), but the named-binding import must be gone.
      expect(result.code).not.toContain(
        "import { searchInputClassName } from './search-on-view'"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines cross-file css class name re-exported via a same-file alias', async () => {
    // box.tsx pattern:
    //   const strokeContainer = css\`...\`;
    //   export const BoxStroke = strokeContainer;
    // A consumer interpolates BoxStroke directly. Resolution must follow
    // the alias to the original css binding's class name.
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const sourceFile = join(root, 'box.tsx');
    const entryFile = join(root, 'apps-listing.tsx');
    const dsFile = join(root, 'design-system.ts');

    writeFileSync(
      dsFile,
      dedent`
        export const themeVars = { textColor: 'var(--text)' };
      `
    );

    writeFileSync(
      sourceFile,
      dedent`
        import { css } from 'test-css-processor';
        import { themeVars } from './design-system';

        const strokeContainer = css\`
          color: ${'${themeVars.textColor}'};
        \`;
        const opacityContainerClass = css\`
          opacity: 0.5;
        \`;

        export const BoxStroke = strokeContainer;
        export const BoxOpacityContainer = opacityContainerClass;
      `
    );

    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { BoxStroke, BoxOpacityContainer } from './box';

        export const listing = css\`
          .${'${BoxStroke}'} { background: blue; }
          .${'${BoxOpacityContainer}'} { background: green; }
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('background:blue');
      expect(result.cssText).toContain('background:green');
      expect(result.code).not.toContain(
        "import { BoxStroke, BoxOpacityContainer } from './box'"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines exported plain ObjectExpression with cross-file ref in computed property key (rowItemStyles)', async () => {
    // context-menu/index.tsx pattern:
    //   export const rowItemStyles = {
    //     ...textStyles.regular,
    //     [`${mobileRootSelector} &`]: { ... },
    //   };
    // A consumer imports rowItemStyles and interpolates it as ${rowItemStyles}
    // inside a styled template. The computed property key references a
    // cross-file binding (mobileRootSelector).
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const sourceFile = join(root, 'context-menu.tsx');
    const entryFile = join(root, 'view-create-actions-menu.tsx');
    const dsFile = join(root, 'design-system.ts');
    const mobileFile = join(root, 'mobile-styles.ts');

    writeFileSync(
      dsFile,
      dedent`
        export const space = { s4: 4, s8: 8, s12: 12 } as const;
        export const layout = { menuItemHeight: 32, mobileMenuItemHeight: 44 } as const;
        export const textStyles = {
          regular: { fontSize: 14 },
          big: { fontSize: 16 },
        };
        export const themeVars = {
          colorBgActionsMenuItemHover: 'var(--menu-hover)',
          disabledTextColor: 'var(--disabled-text)',
          transparent: 'transparent',
        };
      `
    );
    writeFileSync(
      mobileFile,
      dedent`
        export const mobileRootSelector = '.mobile-root';
      `
    );
    writeFileSync(
      sourceFile,
      dedent`
        import { layout, space, textStyles, themeVars } from './design-system';
        import { mobileRootSelector } from './mobile-styles';

        export const rowItemStyles = {
          ...textStyles.regular,
          minHeight: layout.menuItemHeight,
          padding: \`0px ${'${space.s8}'}px\`,
          margin: \`0px ${'${space.s4}'}px\`,
          '&:hover': {
            backgroundColor: themeVars.colorBgActionsMenuItemHover,
          },
          [\`${'${mobileRootSelector}'} &\`]: {
            ...textStyles.big,
            minHeight: layout.mobileMenuItemHeight,
            padding: \`0px ${'${space.s12}'}px\`,
          },
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { rowItemStyles } from './context-menu';

        export const className = css\`
          ${'${{ ...rowItemStyles, color: \'red\' }}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('font-size:14');
      expect(result.cssText).toContain('min-height:32');
      expect(result.cssText).toContain('.mobile-root');
      expect(result.code).not.toContain('./context-menu');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines binary expression over same-file const-bound MemberExpression (settings-form INPUT_LABEL_GAP)', async () => {
    // settings-form.tsx pattern:
    //   const INPUT_LABEL_GAP = space.s24;
    //   const INPUT_WIDTH = 32;
    //   ${INPUT_WIDTH + INPUT_LABEL_GAP}
    // The candidate is a binary expression over a same-file const whose
    // init is a MemberExpression on an imported binding.
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'settings-form.tsx');
    const dsFile = join(root, 'design-system.ts');

    writeFileSync(
      dsFile,
      dedent`
        export const space = { s24: 24 } as const;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { space } from './design-system';

        const INPUT_LABEL_GAP = space.s24;
        const INPUT_WIDTH = 32;

        export const className = css\`
          flex-basis: calc(100% - ${'${INPUT_WIDTH + INPUT_LABEL_GAP}'}px);
          gap: ${'${INPUT_LABEL_GAP}'}px;
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('flex-basis:calc(100% - 56px)');
      expect(result.cssText).toContain('gap:24px');
      expect(result.code).not.toContain('./design-system');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FIXME: seq00044 (text-editor/src/editor/style.ts) rejects with
  // candidate-expression-non-serializable in the bench, but reduced
  // attempts here pass. The trigger is something specific to the real
  // file's giant nested ObjectExpression that isolated reductions don't
  // capture. Leaving the close-but-passing repro for now.
  it.skip('inlines candidate that spreads same-file ObjectExpression alongside a cross-file imported ObjectExpression (editor style.ts)', async () => {
    // text-editor/src/editor/style.ts pattern (seq00044): the candidate
    // spreads multiple sources including an imported plain ObjectExpression
    // from another file (regularRichEditorHTMLStyles, smallHtmlStylesClass)
    // alongside same-file mentionMarkStyles + same-file commentColor const.
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'editor-style.ts');
    const dsFile = join(root, 'design-system.ts');
    const htmlStylesFile = join(root, 'html-styles.ts');

    writeFileSync(
      dsFile,
      dedent`
        export const space = { s3: 3, s5: 5, s8: 8 } as const;
        export const lineHeight = { regular: 1.5 } as const;
        export const themeVars = {
          commentColor: 'var(--comment)',
          textColor: 'var(--text)',
          disabledTextColor: 'var(--disabled)',
          textSelectionColor: 'var(--text-selection)',
        };
      `
    );
    writeFileSync(
      htmlStylesFile,
      dedent`
        import { themeVars } from './design-system';

        export const regularRichEditorHTMLStyles = {
          '& p': {
            color: themeVars.textColor,
            marginTop: 0,
          },
          '& strong': { fontWeight: 600 },
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { lineHeight, space, themeVars } from './design-system';
        import { regularRichEditorHTMLStyles } from './html-styles';

        const commentColor = themeVars.commentColor;
        const mentionMarkStyles = {
          'span[data-hint-query="true"]': {
            color: themeVars.disabledTextColor,
            opacity: 0.5,
          },
        };

        export const editorClassName = css\`
          ${'${{'}
            ...mentionMarkStyles,
            ...regularRichEditorHTMLStyles,
            '@keyframes cursorBlinkingAnimation': {
              '0%': { opacity: 1 },
              '50%': { opacity: 0 },
              '100%': { opacity: 1 },
            },
            '& .comment': {
              borderBottom: \`2px solid ${'${commentColor}'}\`,
            },
            '& .comment.active': {
              background: commentColor,
            },
            '.ProseMirror-gapcursor::after': {
              marginTop: space.s5,
              paddingTop: space.s3,
              lineHeight: lineHeight.regular,
              borderLeft: \`1px solid ${'${themeVars.textColor}'}\`,
            },
            '& *::selection': {
              backgroundColor: themeVars.textSelectionColor,
              color: themeVars.textColor,
            },
          ${'}}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('color:var(--disabled)');
      expect(result.cssText).toContain('font-weight:600');
      expect(result.cssText).toContain('border-bottom:2px solid var(--comment)');
      expect(result.cssText).toContain('background:var(--comment)');
      expect(result.cssText).toContain('background-color:var(--text-selection)');
      expect(result.code).not.toContain('./design-system');
      expect(result.code).not.toContain('./html-styles');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines candidate using same-file MemberExpression-init const + spread of same-file ObjectExpression (editor style.ts)', async () => {
    // text-editor/src/editor/style.ts pattern:
    //   const commentColor = themeVars.commentColor;
    //   const mentionMarkStyles = { '...': {...} };
    //   ${{ ...mentionMarkStyles, '& .comment': { borderBottom: \`2px solid ${commentColor}\` } }}
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'editor-style.ts');
    const dsFile = join(root, 'design-system.ts');

    writeFileSync(
      dsFile,
      dedent`
        export const space = { s5: 5, s8: 8 } as const;
        export const lineHeight = { regular: 1.5 } as const;
        export const themeVars = {
          commentColor: 'var(--comment)',
          textColor: 'var(--text)',
          disabledTextColor: 'var(--disabled)',
          richTextTableBorder: 'var(--table-border)',
          unitBg: 'var(--unit-bg)',
          textSelectionColor: 'var(--text-selection)',
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { lineHeight, space, themeVars } from './design-system';

        const commentColor = themeVars.commentColor;
        const mentionMarkStyles = {
          'span[data-hint-query="true"]': {
            color: themeVars.disabledTextColor,
            opacity: 0.5,
          },
        };

        export const editorClassName = css\`
          ${'${{'}
            ...mentionMarkStyles,
            '& .comment': {
              borderBottom: \`2px solid ${'${commentColor}'}\`,
            },
            '& .comment.active': {
              background: commentColor,
            },
            '& *::selection': {
              backgroundColor: themeVars.textSelectionColor,
              marginTop: space.s5,
              lineHeight: lineHeight.regular,
            },
          ${'}}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('color:var(--disabled)');
      expect(result.cssText).toContain('opacity:0.5');
      expect(result.cssText).toContain('border-bottom:2px solid var(--comment)');
      expect(result.cssText).toContain('background:var(--comment)');
      expect(result.cssText).toContain('background-color:var(--text-selection)');
      expect(result.code).not.toContain('./design-system');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines cross-file MemberExpression on a plain ObjectExpression even when source-side import resolution flickers (cssConstants)', async () => {
    // canvas/components/{comments-sidebar,activity}.tsx pattern (seq00033/00038):
    //   // css-constants.ts
    //   import { space } from '@fibery/ui-kit/src/design-system';
    //   export const cssConstants = { common: space.s10, sidebarWidth: 340 };
    //
    //   // consumer
    //   ${cssConstants.common}
    //
    // In the bench, the resolver returns null when css-constants.ts asks
    // for design-system, even though every other file in the project gets
    // it back fine. wyw should still resolve cssConstants if a) the
    // resolver succeeds even once for the same source/imported pair, or
    // b) we can fall back to the consumer's resolver call.
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const tokensFile = join(root, 'design-system.ts');
    const sourceFile = join(root, 'css-constants.ts');
    const entryFile = join(root, 'comments-sidebar.tsx');

    writeFileSync(
      tokensFile,
      dedent`
        export const space = { s10: 10 } as const;
      `
    );
    writeFileSync(
      sourceFile,
      dedent`
        import { space } from '@pkg/design-system';

        export const cssConstants = {
          common: space.s10,
          sidebarWidth: 340,
        };
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        // Direct import of the alias from the entry succeeds and primes
        // the cross-importer resolution cache.
        import { space } from '@pkg/design-system';
        import { cssConstants } from './css-constants';

        export const sentinel = css\`
          margin: ${'${space.s10}'}px;
        \`;
        export const className = css\`
          padding: ${'${cssConstants.common}'}px;
          width: ${'${cssConstants.sidebarWidth}'}px;
        \`;
      `
    );

    // Resolver that consistently returns null for the
    // css-constants.ts → @pkg/design-system pair (mimicking the bench's
    // dependency-unresolved symptom for this specific importer). Other
    // importers can still resolve the alias fine.
    const flakyResolver = async (what: string, importer: string) => {
      if (
        what === '@pkg/design-system' &&
        importer.endsWith('css-constants.ts')
      ) {
        return null;
      }
      if (what === '@pkg/design-system') {
        return tokensFile;
      }
      if (what === 'test-css-processor') {
        return processorFile;
      }
      if (what.startsWith('.')) {
        const base = resolve(dirname(importer), what);
        for (const ext of ['.ts', '.tsx', '.js']) {
          const candidate = `${base}${ext}`;
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
          }
        }
        return base;
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
        flakyResolver
      );

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('padding:10px');
      expect(result.cssText).toContain('width:340px');
      expect(result.code).not.toContain('./css-constants');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines same-file styled-component className referenced in own css template (box.tsx BoxRoot)', async () => {
    // box.tsx pattern (seq00039): a styled component declared in the
    // same module is interpolated into another css template in the same
    // module. The candidate _exp = () => BoxRoot needs BoxRoot's value
    // — which for css interpolation is its className string. The
    // current fix excludes styled processors from
    // processorClassNamesByLocal (because their value is richer
    // metadata used for composition), so the candidate evaluator can't
    // fold ${BoxRoot} as a className inside a sibling css template.
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'box.tsx');
    const styledProcessorFile = join(
      __dirname,
      '__fixtures__',
      'test-styled-processor.js'
    );

    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { styled } from 'test-styled-processor';

        const BoxRoot = styled.div\`
          padding: 8px;
        \`;

        export const BoxHover = css\`
          ${'${BoxRoot}'}:hover { background: yellow; }
        \`;
      `
    );

    const styledAwareResolver = async (what: string, importer: string) => {
      if (what === 'test-css-processor') {
        return processorFile;
      }
      if (what === 'test-styled-processor') {
        return styledProcessorFile;
      }
      if (what.startsWith('.')) {
        const base = resolve(dirname(importer), what);
        for (const ext of ['.ts', '.tsx', '.js']) {
          const candidate = `${base}${ext}`;
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
          }
        }
        return base;
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
            root,
            pluginOptions: {
              configFile: false,
              features: { staticImportValues: true },
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
        styledAwareResolver
      );

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('padding:8px');
      expect(result.cssText).toContain('background:yellow');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not fall back to evalFile for styled dynamic-prop function candidates (UnitContentLayout)', async () => {
    // ui-kit/src/unit/unit-content-layout.tsx pattern (seq00040/00041
    // in the bench, transitively pulling in unit/styles.ts):
    //   export const UnitContentLayout = styled.div\`
    //     grid-template-rows: \${getRows};
    //     grid-template-columns: \${getCols};
    //   \`;
    //
    // The candidates `_exp = () => getRows` resolve to function values.
    // The evaluator should accept them as runtime callbacks (not as
    // values needing eval), keep the helper arrow alive in the bundle,
    // and skip evalFile.
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
    const cache = new TransformCacheCollection();
    const perf = createPerfEventRecorder();
    const entryFile = join(root, 'unit-content-layout.tsx');
    const stylesFile = join(root, 'styles.ts');
    const dsFile = join(root, 'design-system.ts');
    const styledProcessorFile = join(
      __dirname,
      '__fixtures__',
      'test-styled-processor.js'
    );

    writeFileSync(
      dsFile,
      dedent`
        export const space = { s2: 2, s8: 8 } as const;
        export const fontSize = { sm: 14, xs: 12 } as const;
      `
    );
    writeFileSync(
      stylesFile,
      dedent`
        import { fontSize, space } from './design-system';

        export const regularTextUnitSize = fontSize.sm + space.s8;
        export const smallTextUnitSize = fontSize.xs + space.s8;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';

        import { regularTextUnitSize, smallTextUnitSize } from './styles';

        export const getHeight = (big) =>
          big ? regularTextUnitSize : smallTextUnitSize;

        const getRows = ({ big }) => 'minmax(' + getHeight(big) + 'px, max-content)';
        const getCols = ({ iconsLength }) => 'repeat(' + iconsLength + ', auto)';

        export const UnitContentLayout = styled.div\`
          grid-template-rows: ${'${getRows}'};
          grid-template-columns: ${'${getCols}'};
        \`;
      `
    );

    const styledAwareResolver = async (what: string, importer: string) => {
      if (what === 'test-css-processor') {
        return processorFile;
      }
      if (what === 'test-styled-processor') {
        return styledProcessorFile;
      }
      if (what.startsWith('.')) {
        const base = resolve(dirname(importer), what);
        for (const ext of ['.ts', '.tsx', '.js']) {
          const candidate = `${base}${ext}`;
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
          }
        }
        return base;
      }
      return null;
    };

    try {
      await transform(
        {
          cache,
          eventEmitter: perf.eventEmitter,
          options: {
            filename: entryFile,
            root,
            pluginOptions: {
              configFile: false,
              features: { staticImportValues: true },
              tagResolver: (source, tag) => {
                if (source === 'test-styled-processor' && tag === 'styled') {
                  return styledProcessorFile;
                }
                return null;
              },
            },
          },
        },
        readFileSync(entryFile, 'utf8'),
        styledAwareResolver
      );

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('inlines mixed same-file + cross-file spread chain (typeBadge pattern)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-spread-repro-'));
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
        import { textStyles, space } from './design-system';

        const typeBadgeStaticStyle = {
          display: 'inline-grid',
          ...textStyles.heading6,
          letterSpacing: 1.5,
        };

        const normalTypeBadgeStyleObject = {
          ...typeBadgeStaticStyle,
          paddingLeft: space.s6,
        };

        export const className = css\`
          ${'${normalTypeBadgeStyleObject}'};
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

      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
      expect(result.cssText).toContain('display:inline-grid');
      expect(result.cssText).toContain('font-size:12');
      expect(result.cssText).toContain('letter-spacing:1.5');
      expect(result.cssText).toContain('padding-left:6');
      expect(result.code).not.toContain('./design-system');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
