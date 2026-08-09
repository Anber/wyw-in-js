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

const cssProcessorFile = join(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);
const styledProcessorFile = join(
  __dirname,
  '__fixtures__',
  'test-styled-processor.js'
);

const resolver = async (what: string, importer: string) => {
  if (what === 'test-css-processor') {
    return cssProcessorFile;
  }
  if (what === 'test-styled-processor') {
    return styledProcessorFile;
  }
  if (!what.startsWith('.')) {
    return null;
  }

  const base = resolve(dirname(importer), what);
  for (const extension of ['', '.ts', '.tsx', '.js']) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return base;
};

const runStatic = (root: string, entryFile: string) =>
  transform(
    {
      cache: new TransformCacheCollection(),
      options: {
        filename: entryFile,
        root,
        pluginOptions: {
          configFile: false,
          eval: { strategy: 'static' },
          tagResolver: (source, tag) => {
            if (source === 'test-css-processor' && tag === 'css') {
              return cssProcessorFile;
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
    resolver
  );

describe('static strategy runtime hazard regressions', () => {
  it('resolves an imported member after an unrelated runtime call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-runtime-call-repro-'));
    const entryFile = join(root, 'entry.ts');

    writeFileSync(
      join(root, 'tokens.ts'),
      dedent`
        export const tokens = {
          first: 'red',
          second: 'blue',
        } as const;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import runtime from 'runtime-only';
        import { tokens } from './tokens';

        export function render() {
          const first = css\`
            color: ${'${tokens.first}'};
          \`;
          runtime(first);
          return css\`
            color: ${'${tokens.second}'};
          \`;
        }
      `
    );

    try {
      const result = await runStatic(root, entryFile);

      expect(result.cssText).toContain('color:red');
      expect(result.cssText).toContain('color:blue');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves an import in a binary expression after a runtime wrapper', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-binary-call-repro-'));
    const entryFile = join(root, 'entry.ts');

    writeFileSync(
      join(root, 'tokens.ts'),
      `export const tokens = { gap: 8 } as const;`
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import runtime from 'runtime-only';
        import { tokens } from './tokens';

        const width = 32;

        export const first = css\`
          gap: ${'${tokens.gap}'}px;
        \`;

        export const component = runtime(function Component(props) {
          return runtime(first, props.className);
        });

        export const second = css\`
          width: ${'${width + tokens.gap}'}px;
        \`;
      `
    );

    try {
      const result = await runStatic(root, entryFile);

      expect(result.cssText).toContain('gap:8px');
      expect(result.cssText).toContain('width:40px');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a static export after a derived value helper call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-helper-call-repro-'));
    const entryFile = join(root, 'entry.ts');

    writeFileSync(
      join(root, 'tokens.ts'),
      dedent`
        export const tokens = {
          accent: 'purple',
          border: 'gray',
        } as const;
      `
    );
    writeFileSync(
      join(root, 'effects.ts'),
      dedent`
        import { tokens } from './tokens';

        function withAlpha(value, alpha) {
          return value + ' ' + Math.round(alpha * 100) + '%';
        }

        export const accentWithAlpha = withAlpha(tokens.accent, 0.7);
        export const effects = {
          border: '1px solid ' + tokens.border,
        } as const;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { effects } from './effects';

        export const className = css\`
          border: ${'${effects.border}'};
        \`;
      `
    );

    try {
      const result = await runStatic(root, entryFile);

      expect(result.cssText).toContain('border:1px solid gray');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a sibling import after a statically pure helper call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-sibling-call-repro-'));
    const entryFile = join(root, 'entry.ts');

    writeFileSync(
      join(root, 'tokens.ts'),
      dedent`
        export const runtimeLabel = 'runtime';
        export const tokens = { gap: 8 } as const;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { runtimeLabel, tokens } from './tokens';

        function getRuntimeLabel() {
          return runtimeLabel;
        }

        getRuntimeLabel();

        export const className = css\`
          gap: ${'${tokens.gap}'}px;
        \`;
      `
    );

    try {
      const result = await runStatic(root, entryFile);

      expect(result.cssText).toContain('gap:8px');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores sibling-import escapes inside runtime-only function bodies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-sibling-runtime-repro-'));
    const entryFile = join(root, 'entry.ts');

    writeFileSync(
      join(root, 'tokens.ts'),
      dedent`
        export const runtimeLabel = 'runtime';
        export const tokens = { gap: 8 } as const;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import runtime from 'runtime-only';
        import { runtimeLabel, tokens } from './tokens';

        export function render() {
          return runtime(runtimeLabel);
        }

        export const className = css\`
          gap: ${'${tokens.gap}'}px;
        \`;
      `
    );

    try {
      const result = await runStatic(root, entryFile);

      expect(result.cssText).toContain('gap:8px');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores same-import reads inside runtime-only function bodies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-same-import-runtime-repro-'));
    const entryFile = join(root, 'entry.ts');

    writeFileSync(
      join(root, 'tokens.ts'),
      dedent`
        export const tokens = {
          runtimeLabel: 'runtime',
          gap: 8,
        } as const;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import runtime from 'runtime-only';
        import { tokens } from './tokens';

        export function render() {
          return runtime(tokens.runtimeLabel);
        }

        export const className = css\`
          gap: ${'${tokens.gap}'}px;
        \`;
      `
    );

    try {
      const result = await runStatic(root, entryFile);

      expect(result.cssText).toContain('gap:8px');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores read-only captures passed to a runtime-only top-level wrapper', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-wrapper-capture-repro-'));
    const entryFile = join(root, 'entry.ts');

    writeFileSync(
      join(root, 'tokens.ts'),
      dedent`
        export const colors = {
          runtime: 'red',
          static: 'blue',
        } as const;
        export const layout = { gap: 8 } as const;
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import memoize from 'runtime-only';
        import { colors, layout } from './tokens';

        const getRuntimeStyle = memoize(() => ({
          color: colors.runtime,
        }));

        export function render() {
          return getRuntimeStyle();
        }

        export const className = css\`
          color: ${'${colors.static}'};
          gap: ${'${layout.gap}'}px;
        \`;
      `
    );

    try {
      const result = await runStatic(root, entryFile);

      expect(result.cssText).toContain('color:blue');
      expect(result.cssText).toContain('gap:8px');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps transitive styled callbacks as runtime values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-callback-repro-'));
    const entryFile = join(root, 'entry.js');

    writeFileSync(
      join(root, 'colors.js'),
      `export const colors = { active: 'green', idle: 'gray' };`
    );
    writeFileSync(join(root, 'layout.js'), `export const layout = { gap: 2 };`);
    writeFileSync(
      entryFile,
      dedent`
        import { styled } from 'test-styled-processor';
        import { colors } from './colors.js';
        import { layout } from './layout.js';

        const resolveColor = (active) =>
          active ? colors.active : colors.idle;
        const getColor = (props) => resolveColor(props.active);
        const getBackground = (props) => resolveColor(!props.active);

        export const Root = styled.div\`
          padding: ${'${layout.gap}'}px;
          color: ${'${getColor}'};
          background: ${'${getBackground}'};
        \`;
      `
    );

    try {
      const result = await runStatic(root, entryFile);

      expect(result.cssText).toContain('padding:2px');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
