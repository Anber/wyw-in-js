import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as babel from '@babel/core';

import { loadWywOptions } from '../../helpers/loadWywOptions';
import { withDefaultServices } from '../../helpers/withDefaultServices';
import { Entrypoint } from '../../Entrypoint';
import { getExports } from '../getExports';

import { expectIteratorReturnResult } from './helpers';

describe('getExports: ArrayPattern', () => {
  it('returns binding identifiers exported via array destructuring', () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-issue-106-'));
    const filename = join(root, 'a.ts');

    writeFileSync(
      filename,
      [
        'export const A = 100;',
        'export const [B] = [200];',
        'export const [, C] = [0, 300];',
        'export const [{ D }] = [{ D: 400 }];',
        'export const [...rest] = [500, 600];',
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
      options: { root, filename, pluginOptions },
    });

    const entrypoint = Entrypoint.createRoot(
      services,
      filename,
      ['*'],
      undefined
    );
    const action = entrypoint.createAction('getExports', undefined, null);
    const gen = getExports.call(action);

    const result = gen.next();
    expectIteratorReturnResult(result);
    expect(result.value.sort()).toEqual(['A', 'B', 'C', 'D', 'rest'].sort());
  });
});
