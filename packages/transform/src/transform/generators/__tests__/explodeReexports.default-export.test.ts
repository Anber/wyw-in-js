import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as babel from '@babel/core';

import { loadWywOptions } from '../../helpers/loadWywOptions';
import { withDefaultServices } from '../../helpers/withDefaultServices';
import { Entrypoint } from '../../Entrypoint';
import type { IEntrypointDependency } from '../../Entrypoint.types';
import { getExports } from '../getExports';
import { explodeReexports } from '../explodeReexports';

import {
  expectIteratorReturnResult,
  expectIteratorYieldResult,
} from './helpers';

describe('explodeReexports: default export', () => {
  it('does not re-export default when expanding `export *`', () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-issue-223-'));
    const fileA = join(root, 'a.ts');
    const fileB = join(root, 'b.ts');

    writeFileSync(
      fileA,
      [
        'export const NumberDecimal = 1;',
        'export const BigIntDecimal = 2;',
        'export const toFixed = () => "ok";',
        'export default function getMiniDecimal() { return 0; }',
        '',
      ].join('\n')
    );

    writeFileSync(
      fileB,
      [
        'import getMiniDecimal from "./a";',
        'export * from "./a";',
        'export default getMiniDecimal;',
        '',
      ].join('\n')
    );

    const pluginOptions = loadWywOptions({
      configFile: false,
      babelOptions: {
        babelrc: false,
        configFile: false,
        presets: [
          ['@babel/preset-env', { loose: true }],
          '@babel/preset-typescript',
        ],
      },
    });

    const services = withDefaultServices({
      babel,
      options: { root, filename: fileB, pluginOptions },
    });

    const entrypointB = Entrypoint.createRoot(
      services,
      fileB,
      ['*'],
      undefined
    );
    const action = entrypointB.createAction(
      'explodeReexports',
      undefined,
      null
    );
    const gen = explodeReexports.call(action);

    const initial = gen.next();
    expectIteratorYieldResult(initial);
    expect(initial.value[0]).toBe('resolveImports');

    const resolvedImports: IEntrypointDependency[] = [
      {
        source: './a',
        only: [],
        resolved: fileA,
      },
    ];

    const afterResolve = gen.next(resolvedImports);
    expectIteratorYieldResult(afterResolve);
    expect(afterResolve.value[0]).toBe('getExports');

    const entrypointA = afterResolve.value[1];
    const getExportsAction = entrypointA.createAction(
      'getExports',
      undefined,
      null
    );
    const getExportsGen = getExports.call(getExportsAction);
    const exportsResult = getExportsGen.next();
    expectIteratorReturnResult(exportsResult);

    const done = gen.next(exportsResult.value);
    expectIteratorReturnResult(done, undefined);

    const reexported = new Set<string>();
    babel.traverse(entrypointB.loadedAndParsed.ast!, {
      ExportNamedDeclaration(exportPath) {
        const { source } = exportPath.node;
        if (!source || !babel.types.isStringLiteral(source)) return;
        if (source.value !== './a') return;

        exportPath.node.specifiers.forEach((specifier) => {
          if (
            babel.types.isExportSpecifier(specifier) &&
            babel.types.isIdentifier(specifier.exported)
          ) {
            reexported.add(specifier.exported.name);
          }
        });
      },
    });

    expect(Array.from(reexported).sort()).toEqual(
      ['BigIntDecimal', 'NumberDecimal', 'toFixed'].sort()
    );
    expect(reexported.has('default')).toBe(false);
  });
});
