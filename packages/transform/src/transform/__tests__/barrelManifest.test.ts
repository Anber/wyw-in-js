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

  it('treats side-effect-only imports as runtime barrel content', () => {
    expect(
      analyze(`import './setup';\nexport { red } from './red';\n`)
    ).toEqual({
      kind: 'ineligible',
      reason: 'impure',
    });
  });

  it('skips per-specifier type-only reexports in mixed export lists', () => {
    expect(analyze(`export { type Foo, bar } from './leaf';\n`)).toEqual({
      complete: true,
      explicitExports: ['bar'],
      exportAll: [],
      kind: 'barrel',
      reexports: [
        {
          exported: 'bar',
          imported: 'bar',
          kind: 'named',
          source: './leaf',
        },
      ],
    });
  });

  it('collects passthrough imports from mixed modules and marks local exports incomplete', () => {
    expect(
      analyze(
        `import Red from './red';\nexport { Red as red };\nexport const local = 'local';\n`
      )
    ).toEqual({
      complete: false,
      explicitExports: ['red', 'local'],
      exportAll: [],
      kind: 'barrel',
      reexports: [
        {
          exported: 'red',
          imported: 'default',
          kind: 'named',
          source: './red',
        },
      ],
    });
  });
});
