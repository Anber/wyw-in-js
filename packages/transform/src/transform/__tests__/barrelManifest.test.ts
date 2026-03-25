import * as babel from '@babel/core';

import { analyzeBarrelFile } from '../barrelManifest';

const analyze = (code: string) =>
  analyzeBarrelFile(
    babel.parse(code, {
      babelrc: false,
      filename: '/virtual/test.ts',
      presets: ['@babel/preset-typescript'],
    })!
  );

describe('analyzeBarrelFile', () => {
  it('treats TypeScript enums as impure because they emit runtime code', () => {
    expect(
      analyze(`enum Kind { Foo }\nexport { red } from './red';\n`)
    ).toEqual({
      kind: 'ineligible',
      reason: 'impure',
    });
  });

  it('treats TypeScript namespaces as impure because they emit runtime code', () => {
    expect(
      analyze(
        `namespace Runtime { export const value = 1; }\nexport { red } from './red';\n`
      )
    ).toEqual({
      kind: 'ineligible',
      reason: 'impure',
    });
  });
});
