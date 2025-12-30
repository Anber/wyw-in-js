import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as babel from '@babel/core';

import { loadWywOptions } from '../../helpers/loadWywOptions';
import { withDefaultServices } from '../../helpers/withDefaultServices';
import { Entrypoint } from '../../Entrypoint';
import type { IEntrypointDependency } from '../../Entrypoint.types';
import { explodeReexports } from '../explodeReexports';

import {
  expectIteratorReturnResult,
  expectIteratorYieldResult,
} from './helpers';

describe('explodeReexports: ignored target', () => {
  it('keeps `export *` when reexport target is ignored by extensions', () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-issue-82-'));
    const fileA = join(root, 'a.js');
    const fileB = join(root, 'b.jsx');

    writeFileSync(
      fileA,
      ["export * from './b';", "export const bar = 'baz';", ''].join('\n')
    );

    writeFileSync(fileB, ['export const foo = 42;', ''].join('\n'));

    const pluginOptions = loadWywOptions({
      configFile: false,
      extensions: ['.js'],
      babelOptions: {
        babelrc: false,
        configFile: false,
        presets: [['@babel/preset-env', { loose: true }]],
      },
    });

    const services = withDefaultServices({
      babel,
      options: { root, filename: fileA, pluginOptions },
    });

    const entrypointA = Entrypoint.createRoot(
      services,
      fileA,
      ['*'],
      undefined
    );
    const action = entrypointA.createAction(
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
        source: './b',
        only: [],
        resolved: fileB,
      },
    ];

    const done = gen.next(resolvedImports);
    expectIteratorReturnResult(done, undefined);

    const reexported: string[] = [];
    babel.traverse(entrypointA.loadedAndParsed.ast!, {
      ExportAllDeclaration(exportPath) {
        const { source } = exportPath.node;
        if (!source || !babel.types.isStringLiteral(source)) return;
        reexported.push(source.value);
      },
    });

    expect(reexported).toEqual(['./b']);
  });
});
