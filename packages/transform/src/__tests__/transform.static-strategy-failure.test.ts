import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const createResolver = () => async (what: string, importer: string) => {
  if (what === 'test-css-processor') {
    return processorFile;
  }
  if (what.startsWith('.')) {
    const base = resolve(dirname(importer), what);
    for (const ext of ['', '.ts', '.tsx', '.js']) {
      if (existsSync(base + ext)) {
        return base + ext;
      }
    }
    return base;
  }
  return null;
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
          tagResolver: (s: string, t: string) =>
            s === 'test-css-processor' && t === 'css' ? processorFile : null,
        },
      },
    },
    readFileSync(entryFile, 'utf8'),
    createResolver()
  );

describe('eval.strategy "static" failure diagnostics', () => {
  it('names the original interpolation and its import source instead of bare _exp placeholders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const genFile = join(root, 'theme.js');
    const entryFile = join(root, 'entry.js');

    writeFileSync(
      genFile,
      [
        `export const neutral = { light: { "--c": "rgb(1,1,1)" } };`,
        // Not statically foldable -> stays an eval dependency.
        `export const warm = { light: { "--c": "rgb(" + Date.now() + ")" } };`,
      ].join('\n')
    );
    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { neutral, warm } from './theme.js';`,
        'export const className = css`',
        '  html { ${neutral.light} }',
        '  html.warm { ${warm.light} }',
        '`;',
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain('eval.strategy: "static"');
      // The actionable bits: the source expression and where it came from.
      expect(message).toContain('warm.light');
      expect(message).toContain('from ./theme.js');
      // Source expression leads; the _exp placeholder is not shown when known.
      expect(message).not.toMatch(/-\s+_exp/);
      // A specific reason replaces the generic catch-all sentence.
      expect(message).toContain("isn't statically analyzable");
      expect(message).not.toContain('They reference runtime-only values');
      // The unresolvable neutral.light DID resolve, so must not be listed.
      expect(message).not.toContain('neutral.light');
      // Hint to the escape hatch.
      expect(message).toContain('hybrid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still gives the actionable hint when only a placeholder name is available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const entryFile = join(root, 'entry.js');

    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `const spacing = Date.now();`,
        'export const className = css`',
        '  margin: ${spacing}px;',
        '`;',
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain('eval.strategy: "static"');
      expect(message).toContain('could not be resolved at build time');
      // No source expression is available here, so the _exp placeholder is the
      // fallback and the generic catch-all sentence is retained.
      expect(message).toMatch(/-\s+_exp/);
      expect(message).toContain('They reference runtime-only values');
      expect(message).toContain('hybrid');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('distinguishes a missing export (undefined) from a genuinely non-serializable value', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const genFile = join(root, 'theme.js');
    const entryFile = join(root, 'entry.js');

    // themeVars is exported but emptied, so member access yields undefined —
    // the "emptied module" shape, not a non-serializable value.
    writeFileSync(genFile, `export const themeVars = {};\n`);
    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { themeVars } from './theme.js';`,
        'export const className = css`',
        '  color: ${themeVars.accentTextColor};',
        '`;',
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      expect(message).toContain('themeVars.accentTextColor');
      expect(message).toContain('resolved to undefined');
      // Must NOT mislabel an emptied export as non-serializable.
      expect(message).not.toContain('non-serializable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dedupes repeated values and groups one shared cause', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-static-fail-'));
    const genFile = join(root, 'theme.js');
    const entryFile = join(root, 'entry.js');

    writeFileSync(genFile, `export const themeVars = {};\n`);
    writeFileSync(
      entryFile,
      [
        `import { css } from 'test-css-processor';`,
        `import { themeVars } from './theme.js';`,
        'export const a = css`',
        '  color: ${themeVars.textColor};',
        '  outline-color: ${themeVars.textColor};', // duplicate of above
        '  background: ${themeVars.panelBg};',
        '`;',
        'export const b = css`',
        '  ${{',
        '    color: themeVars.textColor,',
        '    backgroundColor: themeVars.panelBg,',
        '  }}',
        '`;',
      ].join('\n')
    );

    try {
      await runStatic(root, entryFile);
      throw new Error('expected static strategy to fail');
    } catch (error) {
      const { message } = error as Error;
      // One shared-cause header, not repeated on every line.
      expect(message).toContain(
        'resolved to undefined (export missing or not exported) from ./theme.js:'
      );
      expect(message.match(/export missing or not exported/g)?.length).toBe(1);
      // The repeated themeVars.textColor collapses to a single counted line.
      expect(message).toContain('- themeVars.textColor (×2)');
      // Inline objects are kept verbatim (no lossy truncation).
      expect(message).toContain('backgroundColor: themeVars.panelBg');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
