/* eslint-env jest */
import { readFileSync } from 'fs';
import { join, relative, sep } from 'path';

import * as babel from '@babel/core';
import type { NodePath } from '@babel/core';
import generator from '@babel/generator';
import { globSync } from 'glob';

import type { MissedBabelCoreTypes } from '../types';
import type { IReexport } from '../utils/collectExportsAndImports';
import { collectExportsAndImports } from '../utils/collectExportsAndImports';

const { File } = babel as typeof babel & MissedBabelCoreTypes;

const fixturesFolder = join(
  __dirname,
  '__fixtures__',
  'collectExportsAndImports'
);

const inputMask = join(fixturesFolder, '*', '*.js').replaceAll(sep, '/');

const inputs = globSync(inputMask)
  .map((filename) => {
    const [testName, compiler] = filename
      .substring(fixturesFolder.length + 1)
      .split(sep);
    return {
      compiler: compiler.replace(/\.input\.js$/, ''),
      filename,
      testName,
    };
  })
  .reduce(
    (acc, { compiler, filename, testName }) => {
      if (!acc[testName]) {
        acc[testName] = [];
      }

      acc[testName].push({
        compiler,
        filename,
      });

      return acc;
    },
    {} as Record<string, { compiler: string; filename: string }[]>
  );

const withoutLocal = <T extends { local: NodePath }>({
  local,
  ...obj
}: T): Omit<T, 'local'> => obj;

interface IRunResults {
  exports: {
    exported: string;
  }[];
  imports: {
    imported: string;
    source: string;
  }[];
  reexports: IReexport[];
}

function runCompiled(code: string): IRunResults {
  const filename = join(__dirname, 'source.ts');

  const ast = babel.parse(code, {
    babelrc: false,
    filename,
    presets: ['@babel/preset-typescript'],
  })!;

  const file = new File({ filename }, { code, ast });

  const collected = collectExportsAndImports(file.path);

  const sortImports = (
    a: { imported: string | null; source: string },
    b: { imported: string | null; source: string }
  ): number => {
    if (a.imported === null || b.imported === null) {
      if (a.imported === null && b.imported === null) {
        return a.source.localeCompare(b.source);
      }

      return a.imported === null ? -1 : 1;
    }

    return a.imported.localeCompare(b.imported);
  };

  const evaluateOrSource = (path: NodePath) => {
    const evaluated = path.evaluate() as {
      confident: boolean;
      deopt?: NodePath;
      value: any;
    };
    if (evaluated.confident) {
      return evaluated.value;
    }

    if (evaluated.deopt?.isVariableDeclarator()) {
      const evaluatedInit = evaluated.deopt.get('init').evaluate();
      if (evaluatedInit.confident) {
        return evaluatedInit.value;
      }
    }

    return generator(path.node).code;
  };

  return {
    exports:
      Object.entries(collected?.exports ?? {})
        .map(([exported, local]) => ({
          exported,
          local: evaluateOrSource(local),
        }))
        .sort((a, b) => a.exported.localeCompare(b.exported)) ?? [],
    imports:
      collected?.imports
        .map(({ local, ...i }) => ({
          ...i,
          local: evaluateOrSource(local),
        }))
        .sort(sortImports) ?? [],
    reexports: collected?.reexports.sort(sortImports) ?? [],
  };
}

const expectations: Record<
  string,
  Partial<IRunResults> | ((results: IRunResults) => void)
> = {
  export_class: {
    exports: [
      {
        exported: 'Foo',
      },
    ],
  },

  export_default: {
    exports: [
      {
        exported: 'default',
      },
    ],
  },

  export_enum: {
    exports: [
      {
        exported: 'E',
      },
    ],
  },

  export_module_exports_eq: {
    exports: [
      {
        exported: 'default',
      },
    ],
  },

  export_named: {
    exports: [
      {
        exported: 'named',
      },
    ],
  },

  export_with_declaration: {
    exports: [
      {
        exported: 'a',
      },
      {
        exported: 'b',
      },
    ],
  },

  export_with_defineProperty_with_getter: {
    exports: [
      {
        exported: 'a',
      },
    ],
  },

  export_with_defineProperty_with_value: {
    exports: [
      {
        exported: 'a',
      },
    ],
  },

  export_with_destruction: {
    exports: [
      {
        exported: 'a',
      },
      {
        exported: 'b',
      },
    ],
  },

  export_with_destruction_and_rest_operator: (results) => {
    expect(
      results.exports.filter((i) => {
        // Esbuild, why?
        return i.exported !== '_a';
      })
    ).toMatchObject([
      {
        exported: 'a',
      },
      {
        exported: 'rest',
      },
    ]);
  },

  import_default: {
    imports: [
      {
        source: 'unknown-package',
        imported: 'default',
      },
    ],
  },

  import_named: {
    imports: [
      {
        source: 'unknown-package',
        imported: 'named',
      },
    ],
  },

  import_renamed: {
    imports: [
      {
        source: 'unknown-package',
        imported: 'named',
      },
    ],
  },

  'import_side-effects': {
    imports: [
      {
        source: 'unknown-package',
        imported: 'side-effect',
      },
    ],
  },

  import_types: {
    imports: [],
  },

  import_wildcard_clear_usage_of_the_imported_namespace: {
    imports: [
      {
        source: 'unknown-package',
        imported: 'anotherNamed',
      },
      {
        source: 'unknown-package',
        imported: 'named',
      },
    ],
  },

  import_wildcard_destructed_namespace: {
    imports: [
      {
        source: 'unknown-package',
        imported: 'named',
      },
    ],
  },

  import_wildcard_dynamic_usage_of_the_imported_namespace: {
    imports: [
      {
        source: 'unknown-package',
        imported: '*',
      },
    ],
  },

  import_wildcard_unclear_usage_of_the_imported_namespace: {
    imports: [
      {
        source: 'unknown-package',
        imported: '*',
      },
    ],
  },

  import_wildcard_unevaluable_usage: {
    imports: [
      {
        source: 'unknown-package',
        imported: '*',
      },
    ],
  },

  're-export___exportStar': ({ exports, imports, reexports }) => {
    expect(reexports.map(withoutLocal)).toMatchObject([
      {
        imported: '*',
        exported: '*',
        source: './moduleA1',
      },
    ]);
    expect(exports).toHaveLength(0);
    expect(imports).toMatchObject([
      {
        source: 'tslib',
        imported: '__exportStar',
      },
    ]);
  },

  're-export_export_all': ({ exports, imports, reexports }) => {
    expect(reexports.map(withoutLocal)).toMatchObject([
      {
        imported: '*',
        exported: '*',
        source: 'unknown-package',
      },
    ]);
    expect(exports).toHaveLength(0);
    if (imports.length) {
      expect(imports).toMatchObject([
        {
          source: 'unknown-package',
          imported: '*',
        },
      ]);
    }
  },

  're-export_mixed_exports': ({ exports, imports, reexports }) => {
    expect(reexports.map(withoutLocal)).toMatchObject([
      {
        imported: '*',
        exported: '*',
        source: './collectExportsAndImports',
      },
      {
        imported: 'default',
        exported: 'isUnnecessaryReactCall',
        source: './isUnnecessaryReactCall',
      },
      {
        imported: 'syncResolve',
        exported: 'syncResolve',
        source: './asyncResolveFallback',
      },
    ]);
    expect(exports).toMatchObject([
      {
        exported: 'default',
        local: 123,
      },
    ]);

    if (imports.length === 3) {
      expect(imports).toMatchObject([
        {
          imported: '*',
          local: '_collectExportsAndImports',
          source: './collectExportsAndImports',
        },
        {
          imported: 'default',
          local: '_isUnnecessaryReactCall',
          source: './isUnnecessaryReactCall',
        },
        {
          imported: 'syncResolve',
          local: '_asyncResolveFallback.syncResolve',
          source: './asyncResolveFallback',
        },
      ]);
    } else if (imports.length === 2) {
      // If wildcard re-export is supported natively
      expect(imports).toMatchObject([
        {
          imported: 'default',
          source: './isUnnecessaryReactCall',
        },
        {
          imported: 'syncResolve',
          source: './asyncResolveFallback',
        },
      ]);
    }
  },

  're-export_multiple_export_all': ({ exports, imports, reexports }) => {
    expect(reexports.map(withoutLocal)).toMatchObject([
      {
        imported: '*',
        exported: '*',
        source: 'unknown-package-1',
      },
      {
        imported: '*',
        exported: '*',
        source: 'unknown-package-2',
      },
    ]);
    expect(exports).toHaveLength(0);

    if (imports.length) {
      expect(imports).toMatchObject([
        {
          source: 'unknown-package-1',
          imported: '*',
        },
        {
          source: 'unknown-package-2',
          imported: '*',
        },
      ]);
    }
  },

  're-export_named': ({ exports, imports, reexports }) => {
    expect(reexports.map(withoutLocal)).toMatchObject([
      {
        imported: 'token',
        exported: 'token',
        source: 'unknown-package',
      },
    ]);
    expect(exports).toHaveLength(0);
    if (imports.length) {
      expect(imports).toMatchObject([
        {
          source: 'unknown-package',
          imported: 'token',
        },
      ]);
    }
  },

  're-export_named_namespace': ({ exports, imports, reexports }) => {
    if (reexports.length) {
      expect(reexports.map(withoutLocal)).toMatchObject([
        {
          imported: '*',
          exported: 'ns',
          source: 'unknown-package',
        },
      ]);
      expect(exports).toHaveLength(0);
      expect(imports).toHaveLength(0);
    } else {
      expect(reexports).toHaveLength(0);
      expect(exports).toMatchObject([
        {
          exported: 'ns',
        },
      ]);
      expect(imports).toMatchObject([
        {
          source: 'unknown-package',
          imported: '*',
        },
      ]);
    }
  },

  're-export_renamed': ({ exports, imports, reexports }) => {
    expect(reexports.map(withoutLocal)).toMatchObject([
      {
        imported: 'token',
        exported: 'renamed',
        source: 'unknown-package',
      },
    ]);
    expect(exports).toHaveLength(0);
    if (imports.length) {
      expect(imports).toMatchObject([
        {
          source: 'unknown-package',
          imported: 'token',
        },
      ]);
    }
  },

  require_deep: {
    imports: [
      {
        source: 'unknown-package',
        imported: 'very',
      },
    ],
  },

  require_default: {
    imports: [
      {
        source: 'unknown-package',
        imported: 'default',
      },
    ],
  },

  require_named: {
    imports: [
      {
        source: 'unknown-package',
        imported: 'named',
      },
    ],
  },

  require_not_an_import: {
    imports: [],
  },

  require_not_in_a_root_scope: {
    imports: [
      {
        source: 'unknown-package',
        imported: 'dep',
      },
    ],
  },

  require_renamed: {
    imports: [
      {
        source: 'unknown-package',
        imported: 'named',
      },
    ],
  },

  require_two_tokens: (results) => {
    // Different compilers may resolve this case to one or two tokens
    results.imports.forEach((item) => {
      expect(item).toMatchObject({
        source: 'unknown-package',
        imported: 'very',
      });
    });
  },

  require_wildcard_clear_usage_of_the_imported_namespace: {
    imports: [
      {
        source: 'unknown-package',
        imported: 'foo',
      },
    ],
  },

  require_wildcard_unclear_usage_of_the_imported_namespace: {
    imports: [
      {
        source: 'unknown-package',
        imported: '*',
      },
    ],
  },

  require_wildcard_using_rest_operator: {
    imports: [
      {
        source: 'unknown-package',
        imported: '*',
      },
    ],
  },

  require_wildcard_using_rest_operator_and_named_import: {
    imports: [
      {
        source: 'unknown-package',
        imported: '*',
      },
      {
        source: 'unknown-package',
        imported: 'named',
      },
    ],
  },
};

const testCases = Object.keys(inputs);

describe('collectExportsAndImports', () => {
  if (testCases.length) {
    describe.each(testCases)('%s', (testName) => {
      it.each(inputs[testName])('$compiler', ({ filename }) => {
        const code = readFileSync(filename, 'utf-8');
        const results = runCompiled(code);
        expect(expectations).toHaveProperty(testName);
        const expectation = expectations[testName];
        if (typeof expectation === 'function') {
          expectation(results);
        } else {
          expect(results).toMatchObject(expectation);
        }
      });
    });
  } else {
    it(`${relative(__dirname, inputMask)} has been resolved to 0 cases`, () => {
      expect(true).toBe(false);
    });
  }
});
