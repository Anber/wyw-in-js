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
});
