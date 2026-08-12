import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

describe('transform() reexport edge narrowing', () => {
  it('links a barrel reexport reached only via a computed dynamic import specifier', async () => {
    // A cold transform() call normally can't reproduce the missing-edge
    // crash the broker-level tests demonstrate: resolveImports statically
    // discovers the barrel as a dependency of the entry (whether the entry
    // imports it directly, or dynamically with a literal specifier), and
    // that static discovery runs the barrel through the real
    // resolveImports/processImports pipeline before the eval broker ever
    // sees it. That pipeline records the barrel's dependency on values.js
    // using the shaker's own importsToMap, which has always included
    // re-exports — so it widens values.js to include `otherValue` before
    // mergeKnownDependencyOnly gets a chance to reuse a narrow cached
    // variant. The bug is real (see eval-broker.test.ts) but masked here by
    // that redundant, always-correct transform-stage record.
    //
    // The one gap: collectFromImportExpression / getStringConstant
    // (utils/collectOxcExportsAndImports.ts) only recognize a dynamic
    // import's specifier when it's a compile-time string constant (a
    // literal, a no-substitution template literal, `+` concatenation, or
    // `.concat()`). A specifier read off a local binding —
    // `import(barrelPath)` — isn't one, so `getStringConstant` returns
    // null and the import is invisible to BOTH resolveImports (no
    // dependency ever recorded for './barrel.js') and
    // collectImportsFromOxc (no entry in the broker's import map either).
    // The barrel is then discovered for the first time entirely inside the
    // eval broker's own module preparation, which — unlike the static
    // pipeline — does not eagerly resolve reexports to concrete names, so
    // its recorded dependency on values.js stays narrow. That's what lets
    // the missing edge actually bite: values.js gets prepared without
    // `otherValue`, the barrel's `export { otherValue } from './values.js'`
    // can't supply it, and entry.js's dynamic `import()` rejects when the
    // runner's vm.SourceTextModule.link fails on the barrel.
    //
    // A computed dynamic-import specifier is an unusual shape, but a real
    // one (e.g. a locale- or brand-scoped module path); this is offered as
    // supporting evidence that the fix matters beyond the broker's own
    // internal state, not as a claim that this is a common crash shape.
    const root = mkdtempSync(join(tmpdir(), 'wyw-reexport-narrowing-'));
    const values = join(root, 'values.js');
    const barrel = join(root, 'barrel.js');
    const entry = join(root, 'entry.js');

    // Computed (not literal) exports keep values.js out of
    // isStaticallyEvaluatableModule, same reasoning as the broker-level
    // tests — otherwise the broker force-widens it to only:['*'] and the
    // defect is masked regardless of the import map.
    writeFileSync(
      values,
      [
        'const base = 16;',
        'export const namedValue = base * 25;',
        'export const otherValue = base * 3;',
      ].join('\n')
    );
    writeFileSync(
      barrel,
      [
        "import { namedValue } from './values.js';",
        "export { otherValue } from './values.js';",
        'export const derived = namedValue * 2;',
      ].join('\n')
    );
    writeFileSync(
      entry,
      [
        "import { css } from 'test-css-processor';",
        "import { namedValue } from './values.js';",
        "const barrelPath = './barrel.js';",
        'const otherValue = (await import(barrelPath)).otherValue;',
        'export const style = css`',
        '  ${JSON.stringify({ namedValue, otherValue })}',
        '`;',
      ].join('\n')
    );

    const cache = new TransformCacheCollection();
    const eventEmitter = new EventEmitter(
      () => {},
      () => 0,
      () => {}
    );

    const resolver = async (what: string, importer: string) => {
      if (what === 'test-css-processor') {
        return processorFile;
      }

      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }

      return null;
    };

    try {
      const result = await transform(
        {
          cache,
          eventEmitter,
          options: {
            filename: entry,
            root,
            pluginOptions: {
              configFile: false,
              eval: { strategy: 'hybrid' },
              tagResolver: (source, tag) =>
                source === 'test-css-processor' && tag === 'css'
                  ? processorFile
                  : null,
            },
          },
        },
        readFileSync(entry, 'utf8'),
        resolver
      );

      expect(result.code).toContain('style');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
