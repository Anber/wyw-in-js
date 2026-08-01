/* eslint-env jest */
import { parseSync, type Program } from 'oxc-parser';

import {
  collectOxcExportsAndImportsFromProgram,
  collectOxcProcessorImportsFromProgram,
} from '../utils/collectOxcExportsAndImports';

const parseProgram = (code: string): Program =>
  parseSync('cache-test.js', code, {
    astType: 'js',
    range: true,
    sourceType: 'module',
  }).program as Program;

describe('collectOxcExportsAndImportsFromProgram cache', () => {
  it('reuses Program analysis without sharing mutable result state', () => {
    const code = `
      import { source } from './source';
      export { source };
      export { other } from './other';
    `;
    const program = parseProgram(code);
    let programWalks = 0;
    const countedProgram = new Proxy(program, {
      ownKeys(target) {
        programWalks += 1;
        return Reflect.ownKeys(target);
      },
    });

    const first = collectOxcExportsAndImportsFromProgram(
      countedProgram,
      code,
      true
    );
    const walksAfterFirstCollection = programWalks;
    expect(walksAfterFirstCollection).toBeGreaterThan(0);

    first.deadExports.push('poisoned');
    first.exports.source.code = 'poisoned';
    first.imports[0]!.local.code = 'poisoned';
    first.reexports[0]!.local.code = 'poisoned';

    const second = collectOxcExportsAndImportsFromProgram(
      countedProgram,
      code,
      true
    );

    expect(programWalks).toBe(walksAfterFirstCollection);
    expect(second).not.toBe(first);
    expect(second.deadExports).toEqual([]);
    expect(second.exports.source.code).toBe('source');
    expect(second.imports[0]!.local.code).toBe('source');
    expect(second.reexports[0]!.local.code).not.toBe('poisoned');
    expect(second.imports[0]).not.toBe(first.imports[0]);
    expect(second.imports[0]!.local).not.toBe(first.imports[0]!.local);
  });

  it('does not reuse results for different code or module modes', () => {
    const firstCode = 'export default 1;';
    const secondCode = 'export default 2;';
    const program = parseProgram(firstCode);

    const first = collectOxcExportsAndImportsFromProgram(
      program,
      firstCode,
      true
    );
    const changedCode = collectOxcExportsAndImportsFromProgram(
      program,
      secondCode,
      true
    );
    const changedModuleMode = collectOxcExportsAndImportsFromProgram(
      program,
      secondCode,
      false
    );

    expect(first.exports.default.code).toBe('1');
    expect(first.isEsModule).toBe(true);
    expect(changedCode.exports.default.code).toBe('2');
    expect(changedCode.isEsModule).toBe(true);
    expect(changedModuleMode.exports.default.code).toBe('2');
    expect(changedModuleMode.isEsModule).toBe(false);
  });
});

describe('collectOxcProcessorImportsFromProgram cache', () => {
  it('reuses Program analysis without sharing mutable result state', () => {
    const code = `
      import { css } from '@wyw-in-js/template-tag';
      css\`color: red;\`;
    `;
    const program = parseProgram(code);
    let programWalks = 0;
    const countedProgram = new Proxy(program, {
      ownKeys(target) {
        programWalks += 1;
        return Reflect.ownKeys(target);
      },
    });

    const first = collectOxcProcessorImportsFromProgram(countedProgram, code);
    const walksAfterFirstCollection = programWalks;
    expect(walksAfterFirstCollection).toBeGreaterThan(0);

    first[0]!.local.code = 'poisoned';
    first.push({ ...first[0]!, local: { ...first[0]!.local } });

    const second = collectOxcProcessorImportsFromProgram(countedProgram, code);

    expect(programWalks).toBe(walksAfterFirstCollection);
    expect(second).toHaveLength(1);
    expect(second[0]!.local.code).toBe('css');
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]!.local).not.toBe(first[0]!.local);
  });

  it('keeps full and processor-only analysis modes separate', () => {
    const code = `import * as tokens from './tokens';`;
    const program = parseProgram(code);

    const full = collectOxcExportsAndImportsFromProgram(program, code, true);
    const processorOnly = collectOxcProcessorImportsFromProgram(program, code);

    expect(full.imports).toMatchObject([
      { imported: 'side-effect', source: './tokens' },
    ]);
    expect(processorOnly).toEqual([]);
  });

  it('does not reuse processor imports for different code', () => {
    const firstCode = `import { one } from './tokens'; one;`;
    const secondCode = `import { two } from './tokens'; two;`;
    const program = parseProgram(firstCode);

    const first = collectOxcProcessorImportsFromProgram(program, firstCode);
    const second = collectOxcProcessorImportsFromProgram(program, secondCode);

    expect(first[0]!.local.code).toBe('one');
    expect(second[0]!.local.code).toBe('two');
  });
});
