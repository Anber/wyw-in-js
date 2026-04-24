/* eslint-env jest */
import { readFileSync } from 'fs';
import { join } from 'path';

import { globSync } from 'glob';

import {
  collectOxcExportsAndImports,
  type OxcCollectedState,
} from '../utils/collectOxcExportsAndImports';

const fixturesFolder = join(
  __dirname,
  '__fixtures__',
  'collectExportsAndImports'
);

type ComparableResults = {
  exports: { exported: string; local: unknown }[];
  imports: { imported: string; source: string }[];
  reexports: { exported: string; imported: string; source: string }[];
};

const sortByImport = (
  a: { imported: string; source: string },
  b: { imported: string; source: string }
): number =>
  a.imported === b.imported
    ? a.source.localeCompare(b.source)
    : a.imported.localeCompare(b.imported);

const evaluateLocal = (value: string): unknown => {
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }

  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }

  return value;
};

const comparable = (result: OxcCollectedState): ComparableResults => ({
  exports: Object.entries(result.exports)
    .map(([exported, local]) => ({
      exported,
      local: evaluateLocal(local.code),
    }))
    .sort((a, b) => a.exported.localeCompare(b.exported)),
  imports: result.imports
    .map(({ imported, source }) => ({ imported, source }))
    .sort(sortByImport),
  reexports: result.reexports
    .map(({ exported, imported, source }) => ({ exported, imported, source }))
    .sort(sortByImport),
});

const runFixture = (relativePath: string): ComparableResults => {
  const filename = join(fixturesFolder, relativePath);
  return comparable(
    collectOxcExportsAndImports(readFileSync(filename, 'utf-8'), filename)
  );
};

describe('collectOxcExportsAndImports', () => {
  it('collects ESM imports, exports, reexports, and type-only statements', () => {
    expect(runFixture('import_named.input.ts').imports).toMatchObject([
      { imported: 'named', source: 'unknown-package' },
    ]);
    expect(runFixture('import_types.input.ts').imports).toEqual([]);
    expect(
      runFixture('export_with_declaration.input.ts').exports
    ).toMatchObject([{ exported: 'a' }, { exported: 'b' }]);
    expect(runFixture('re-export_named.input.ts').reexports).toMatchObject([
      { exported: 'token', imported: 'token', source: 'unknown-package' },
    ]);
    expect(runFixture('re-export_export_all.input.ts').reexports).toMatchObject(
      [{ exported: '*', imported: '*', source: 'unknown-package' }]
    );
  });

  it('preserves namespace import unfolding heuristics', () => {
    expect(
      runFixture(
        'import_wildcard_clear_usage_of_the_imported_namespace.input.ts'
      ).imports
    ).toMatchObject([
      { imported: 'anotherNamed', source: 'unknown-package' },
      { imported: 'named', source: 'unknown-package' },
    ]);

    expect(
      runFixture('import_wildcard_destructed_namespace.input.ts').imports
    ).toMatchObject([{ imported: 'named', source: 'unknown-package' }]);

    expect(
      runFixture(
        'import_wildcard_dynamic_usage_of_the_imported_namespace.input.ts'
      ).imports
    ).toMatchObject([{ imported: '*', source: 'unknown-package' }]);

    expect(
      runFixture(
        'import_wildcard_unclear_usage_of_the_imported_namespace.input.ts'
      ).imports
    ).toMatchObject([{ imported: '*', source: 'unknown-package' }]);
  });

  it('collects require forms used by the compiled CommonJS corpus', () => {
    expect(runFixture('require_default.input.ts').imports).toMatchObject([
      { imported: 'default', source: 'unknown-package' },
    ]);
    expect(runFixture('require_named.input.ts').imports).toMatchObject([
      { imported: 'named', source: 'unknown-package' },
    ]);
    expect(runFixture('require_renamed.input.ts').imports).toMatchObject([
      { imported: 'named', source: 'unknown-package' },
    ]);
    expect(runFixture('require_deep.input.ts').imports).toMatchObject([
      { imported: 'very', source: 'unknown-package' },
    ]);
    expect(runFixture('require_not_an_import.input.ts').imports).toEqual([]);
  });

  it('collects mixed ESM reexports', () => {
    expect(runFixture('re-export_mixed_exports.input.ts')).toMatchObject({
      exports: [{ exported: 'default', local: 123 }],
      reexports: [
        {
          exported: '*',
          imported: '*',
          source: './collectExportsAndImports',
        },
        {
          exported: 'isUnnecessaryReactCall',
          imported: 'default',
          source: './isUnnecessaryReactCall',
        },
        {
          exported: 'syncResolve',
          imported: 'syncResolve',
          source: './asyncResolveFallback',
        },
      ],
    });
  });

  it('collects compiled CommonJS mixed reexport fixtures', () => {
    const files = globSync(
      join(fixturesFolder, 're-export_mixed_exports', '*.input.js')
    );

    expect(files.length).toBeGreaterThan(0);
    files.forEach((filename) => {
      const result = comparable(
        collectOxcExportsAndImports(readFileSync(filename, 'utf-8'), filename)
      );

      expect(result.exports).toContainEqual(
        expect.objectContaining({ exported: 'default' })
      );
      expect(result.reexports).toEqual(
        expect.arrayContaining([
          {
            exported: '*',
            imported: '*',
            source: './collectExportsAndImports',
          },
          {
            exported: 'isUnnecessaryReactCall',
            imported: 'default',
            source: './isUnnecessaryReactCall',
          },
          {
            exported: 'syncResolve',
            imported: 'syncResolve',
            source: './asyncResolveFallback',
          },
        ])
      );
    });
  });

  it('collects compiled CommonJS export-star and defineProperty fixtures', () => {
    globSync(
      join(fixturesFolder, 're-export___exportStar', '*.input.js')
    ).forEach((filename) => {
      const result = comparable(
        collectOxcExportsAndImports(readFileSync(filename, 'utf-8'), filename)
      );

      expect(result.reexports).toEqual(
        expect.arrayContaining([
          { exported: '*', imported: '*', source: './moduleA1' },
        ])
      );
    });

    globSync(
      join(
        fixturesFolder,
        'export_with_defineProperty_with_getter',
        '*.input.js'
      )
    ).forEach((filename) => {
      expect(
        comparable(
          collectOxcExportsAndImports(readFileSync(filename, 'utf-8'), filename)
        ).exports
      ).toContainEqual(expect.objectContaining({ exported: 'a' }));
    });
  });
});
