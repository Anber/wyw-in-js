/* eslint-env jest */
import dedent from 'dedent';

import { ValueType } from '@wyw-in-js/shared';

import { collectOxcTemplateDependencies } from '../collectOxcTemplateDependencies';

const filename = '/source.tsx';

describe('collectOxcTemplateDependencies', () => {
  it('hoists and statically evaluates template expressions', () => {
    const code = dedent`
      import x from "module";

      function fn() {
        const value = 21;
        const variable = "test";
        const result = "result";
        const template = tag\`${'${value * 2}'}${'${variable}'}${'${(() => result)}'}${'${value * x}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain('const _exp = () => (42);');
    expect(result.code).toContain('const _exp2 = () => ("test");');
    expect(result.code).toContain('"result"');
    expect(result.code).toContain('const _exp4 = () => (21 * x);');
    expect(result.code).toContain(
      'tag`${_exp()}${_exp2()}${_exp3()}${_exp4()}`'
    );
    expect(result.staticValues).toEqual(
      expect.arrayContaining([
        { name: '_exp', value: 42 },
        { name: '_exp2', value: 'test' },
      ])
    );
  });

  it('records imported static candidates by generated helper name', () => {
    const code = dedent`
      import { color } from './tokens';

      const template = tag\`${'${color}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValueCandidates).toEqual([
      {
        imports: [
          {
            imported: 'color',
            local: 'color',
            source: './tokens',
          },
        ],
        name: '_exp',
        source: 'color',
      },
    ]);
  });

  it('inserts hoisted expressions after imports and before the owner statement', () => {
    const code = dedent`
      import { styled } from '@linaria/react';
      import slugify from '../__fixtures__/slugify';

      export const Title = styled.h1\`
        &:before {
          content: "${"${slugify('test')}"}"
        }
      \`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code.indexOf('import slugify')).toBeLessThan(
      result.code.indexOf('const _exp')
    );
    expect(result.code.indexOf('const _exp')).toBeLessThan(
      result.code.indexOf('export const Title')
    );
    expect(result.expressionValues[0]).toMatchObject({
      importedFrom: ['../__fixtures__/slugify'],
      kind: ValueType.LAZY,
      source: "slugify('test')",
    });
  });

  it('keeps literal expressions as const dependencies without hoisting', () => {
    const code = dedent`
      const template = tag\`${'${1}'}${'${"red"}'}${'${false}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toBe(code);
    expect(result.expressionValues).toMatchObject([
      { kind: ValueType.CONST, source: '1', value: 1 },
      { kind: ValueType.CONST, source: '"red"', value: 'red' },
      { kind: ValueType.CONST, source: 'false', value: false },
    ]);
  });

  it('rejects expressions that depend on function parameters', () => {
    const code = dedent`
      function fn(arg) {
        {
          const base = "base";
          const variable = base + arg;
          const template = tag\`${'${variable}'}\`;
        }
      }
    `;

    expect(() => collectOxcTemplateDependencies(code, filename, true)).toThrow(
      'function parameter'
    );
  });

  it('treats function interpolation parameters as local to the interpolation', () => {
    const code = dedent`
      import theme from "module";

      const template = tag\`${'${(props) => props.value + theme}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.expressionValues[0]).toMatchObject({
      importedFrom: ['module'],
      kind: ValueType.FUNCTION,
      source: '(props) => props.value + theme',
    });
    expect(result.code).toContain(
      'const _exp = () => ((props) => props.value + theme);'
    );
  });

  it('treats local declarations inside function interpolations as local to the interpolation', () => {
    const code = [
      'const maxCharactesPerLine = 55;',
      'const basicLineHeight = 11;',
      'const lineHeight = 24;',
      '',
      'const template = tag`${(props) => {',
      '  const lines = Math.ceil(props.value.length / maxCharactesPerLine);',
      '  return `${basicLineHeight + lines * lineHeight}px`;',
      '}}`;',
    ].join('\n');

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.expressionValues[0]).toMatchObject({
      kind: ValueType.FUNCTION,
      source: [
        '(props) => {',
        '  const lines = Math.ceil(props.value.length / maxCharactesPerLine);',
        '  return `${basicLineHeight + lines * lineHeight}px`;',
        '}',
      ].join('\n'),
    });
    expect(result.code).toContain('const _exp = () => ((props) => {');
    expect(result.code).toContain(
      'const lines = Math.ceil(props.value.length / 55);'
    );
    expect(result.code).toContain('return `');
    expect(result.code).toContain('${11 + lines * 24}px');
  });

  it('hoists chains of local declarations', () => {
    const code = dedent`
      import str from "module";

      function fn() {
        {
          const arg = str;
          const variable = arg + "2";
          const template = tag\`${'${variable}'}\`;
        }
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain('let _arg = str;');
    expect(result.code).toContain('let _variable = _arg + "2";');
    expect(result.code).toContain('const _exp = () => (_variable);');
    expect(result.code).toContain('tag`${_exp()}`');
  });

  it('hoists destructuring dependencies', () => {
    const code = dedent`
      function fn() {
        const result = "result";
        const { variable } = { variable: result };
        const template = tag\`${'${variable}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain('let _result = "result";');
    expect(result.code).toContain('let { variable } = { variable: _result };');
    expect(result.code).toContain('const _exp = () => (variable);');
  });

  it('preserves importedFrom after local hoisting', () => {
    const code = dedent`
      import slugify from '../__fixtures__/slugify';

      function fn() {
        const input = 'test';
        const template = tag\`${'${slugify(input)}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.expressionValues[0]).toMatchObject({
      importedFrom: ['../__fixtures__/slugify'],
      source: 'slugify(input)',
    });
    expect(result.code).toContain('slugify("test")');
  });

  it('statically evaluates shadowed object-member access', () => {
    const code = dedent`
      const color = 'red';

      function Component() {
        const color = 'blue';
        const val = { color };
        const template = tag\`${'${val.color}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain('const _exp = () => ("blue");');
    expect(result.code).not.toContain('let color =');
    expect(result.code).not.toContain('let val =');
  });

  it('statically evaluates simple local function calls', () => {
    const code = dedent`
      const size = () => 5;

      function Component() {
        const color = size();
        const template = tag\`${'${color}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain('const _exp = () => (5);');
    expect(result.code).not.toContain('let color =');
  });

  it('applies prior top-level object mutations during static evaluation', () => {
    const code = dedent`
      const objects = { font: { fontSize: 12 }, box: { border: '1px solid red' } };
      const foo = (k) => {
        const { [k]: obj } = objects;
        return obj;
      };

      objects.font.fontWeight = 'bold';

      const template = tag\`${'${foo("font")}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain(
      'const _exp = () => (({"fontSize":12,"fontWeight":"bold"}));'
    );
  });

  it('statically evaluates simple helper functions returning object spreads', () => {
    const code = dedent`
      function copyAndExtend(a, b) {
        return { ...a, ...b };
      }

      const obj = copyAndExtend({ a: 1 }, { a: 2 });
      const template = tag\`${'${obj.a}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain('const _exp = () => (2);');
  });

  it('parenthesizes hoisted object-literal interpolations so the body is an expression', () => {
    const code = dedent`
      import { dynamic } from '../__fixtures__/slugify';

      const template = tag\`${'${{ value: dynamic }}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain('const _exp = () => ({ value: dynamic });');
    expect(result.code).not.toContain('const _exp = () => { value: dynamic };');
    expect(() =>
      // eslint-disable-next-line no-new-func,@typescript-eslint/no-implied-eval
      new Function(`const dynamic = 1; return (() => ({ value: dynamic }))()`)()
    ).not.toThrow();
  });

  it('parenthesizes hoisted sequence-expression interpolations so commas survive', () => {
    const code = dedent`
      import { sideEffect, value } from '../__fixtures__/slugify';

      const template = tag\`${'${(sideEffect(), value)}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain(
      'const _exp = () => ((sideEffect(), value));'
    );
  });

  it('does not inline tagged-template root objects into selector helpers', () => {
    const code = dedent`
      import { css } from '@linaria/core';

      export const classes = {
        small: css\`\`,
        contrast: css\`\`,
      };

      const template = tag\`${'${classes.small}'}${'${classes.contrast}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain('const _exp = () => (classes.small);');
    expect(result.code).toContain('const _exp2 = () => (classes.contrast);');
    expect(result.code).not.toContain('const _exp = () => ({');
    expect(result.code).not.toContain('const _exp2 = () => ({');
  });
});
