/* eslint-env jest */
import dedent from 'dedent';
import type { Expression } from 'oxc-parser';

import { collectOxcTemplateDependencies } from '../collectOxcTemplateDependencies';
import {
  collectEagerIdentifierMutationTargets,
  collectEagerNodeStarts,
  collectIdentifierMutationTargets,
  replaceIdentifierReferences,
} from '../collectOxcTemplateDependencies/expressionReplacements';
import { parseOxc } from '../collectOxcTemplateDependencies/scopeAnalysis';

const filename = '/source.tsx';

const parseInitializer = (
  source: string
): { code: string; expression: Expression } => {
  const code = `const value = ${source};`;
  const program = parseOxc(code, filename);
  const declaration = program.body[0];
  if (
    declaration?.type !== 'VariableDeclaration' ||
    !declaration.declarations[0]?.init
  ) {
    throw new Error('Expected a variable initializer');
  }

  return {
    code,
    expression: declaration.declarations[0].init,
  };
};

const evaluateExpression = <T>(
  source: string,
  names: string[] = [],
  values: unknown[] = []
): T =>
  // eslint-disable-next-line no-new-func,@typescript-eslint/no-implied-eval
  new Function(...names, `return (${source});`)(...values) as T;

const evaluateCollectorComponent = <T>(code: string): T => {
  const tag = (_strings: TemplateStringsArray, value: T): T => value;
  // eslint-disable-next-line no-new-func,@typescript-eslint/no-implied-eval
  return new Function('tag', `${code}\nreturn Component();`)(tag) as T;
};

const runtimeHelperSource = (code: string): string => {
  const program = parseOxc(code, filename);
  for (const statement of program.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations) {
        if (
          declarator.id.type === 'Identifier' &&
          declarator.id.name === '_exp' &&
          declarator.init?.type === 'ArrowFunctionExpression' &&
          declarator.init.body.type !== 'BlockStatement'
        ) {
          return code.slice(
            declarator.init.body.start,
            declarator.init.body.end
          );
        }
      }
    }
  }

  throw new Error('Expected a generated _exp helper');
};

describe('identifier reference replacements', () => {
  it.each([
    ['target[key] = value', ['target']],
    ['value += fallback', ['value']],
    ['value++', ['value']],
    [
      '({ width = fallback, nested: object.value, ...rest } = source)',
      ['width', 'object', 'rest'],
    ],
    ['delete target[key]', ['target']],
  ])(
    'identifies mutation roots without classifying target reads in %s',
    (source, expected) => {
      const { expression } = parseInitializer(source);

      expect(
        collectIdentifierMutationTargets(expression).map(({ name }) => name)
      ).toEqual(expected);
    }
  );

  it.each([
    ['() => (value = 2)', ['value'], []],
    ['(() => (value = 2))()', ['value'], ['value']],
    ['(() => { for (value of source) {} })()', ['value'], ['value']],
    ['(() => { for (value in source) {} })()', ['value'], ['value']],
    ['() => { for (value of source) {} }', ['value'], []],
    ['(() => () => (value = 2))()', ['value'], []],
    ['(async () => (value = 2))()', ['value'], []],
    ['(function* () { value = 2; })()', ['value'], []],
  ])(
    'distinguishes all writes from eagerly executed writes in %s',
    (source, allExpected, eagerExpected) => {
      const { expression } = parseInitializer(source);

      expect(
        collectIdentifierMutationTargets(expression).map(({ name }) => name)
      ).toEqual(allExpected);
      expect(
        collectEagerIdentifierMutationTargets(expression).map(
          ({ name }) => name
        )
      ).toEqual(eagerExpected);
    }
  );

  it.each([
    ['() => value', 0],
    ['(() => value)()', 1],
    ['(() => () => value)()', 0],
    ['(async () => value)()', 0],
    ['(function* () { return value; })()', 0],
    ['(() => { for (value of source) {} return value; })()', 2],
  ])(
    'marks only eagerly executed identifier occurrences in %s',
    (source, expectedEagerOccurrences) => {
      const { code, expression } = parseInitializer(source);
      const eagerStarts = collectEagerNodeStarts(expression);
      const valueStarts = [...code.matchAll(/\bvalue\b/g)]
        .map((match) => match.index)
        .filter((start) => start >= expression.start);

      expect(
        valueStarts.filter((start) => eagerStarts.has(start))
      ).toHaveLength(expectedEagerOccurrences);
    }
  );

  it('uses exact reference replacements without touching a nested TDZ binding', () => {
    const source = '[x, () => { return x; const x = 1; }]';
    const { code, expression } = parseInitializer(source);
    const outerReference = code.indexOf('[x') + 1;

    expect(
      replaceIdentifierReferences(
        expression,
        new Map([['x', 'wrong']]),
        code,
        new Map([[outerReference, '400']])
      )
    ).toBe('[400, () => { return x; const x = 1; }]');
  });

  it('preserves nested parameter bindings and replaces only free references', () => {
    const source =
      '[x, { x }, (x = 1) => x, ({ x }) => x, ([x]) => x, (value = x) => value, (value = x) => { var x = 1; return value + x; }, () => { { const x = 1; return x; } return x; }, () => { x: { break x; } return x; }]';
    const { code, expression } = parseInitializer(source);

    expect(
      replaceIdentifierReferences(expression, new Map([['x', '400']]), code)
    ).toBe(
      '[400, { x: 400 }, (x = 1) => x, ({ x }) => x, ([x]) => x, (value = 400) => value, (value = 400) => { var x = 1; return value + x; }, () => { { const x = 1; return x; } return 400; }, () => { x: { break x; } return 400; }]'
    );
  });

  it('honors callable and class predeclaration scopes', () => {
    const source = dedent`
      [
        x,
        class Inner {
          static outer = x;
          static { x; var x = 1; }
          method() { return x; const x = 1; }
        },
        () => { return x; var x = 1; },
        () => { return x; function x() {} },
        () => { return x; class x {} },
        class x { static own = x; }
      ]
    `;
    const { code, expression } = parseInitializer(source);
    const replaced = replaceIdentifierReferences(
      expression,
      new Map([['x', '400']]),
      code
    );

    expect(replaced).toContain('400,');
    expect(replaced).toContain('static outer = 400;');
    expect(replaced).toContain('static { x; var x = 1; }');
    expect(replaced).toContain('method() { return x; const x = 1; }');
    expect(replaced).toContain('() => { return x; var x = 1; }');
    expect(replaced).toContain('() => { return x; function x() {} }');
    expect(replaced).toContain('() => { return x; class x {} }');
    expect(replaced).toContain('class x { static own = x; }');
  });

  it('replaces a switch discriminant before the shared case scope starts', () => {
    const source = dedent`
      (() => {
        switch (x) {
          case 0:
            let x = 400;
            return x;
          default:
            return -1;
        }
      })()
    `;
    const { code, expression } = parseInitializer(source);
    const discriminantReference =
      code.indexOf('switch (x)') + 'switch ('.length;

    expect(
      replaceIdentifierReferences(
        expression,
        new Map([['x', 'wrong']]),
        code,
        new Map([[discriminantReference, '0']])
      )
    ).toBe(dedent`
      (() => {
        switch (0) {
          case 0:
            let x = 400;
            return x;
          default:
            return -1;
        }
      })()
    `);
  });
});

describe('collector identifier replacement scopes', () => {
  it('keeps a nested TDZ binding intact for a local constant', () => {
    const code = dedent`
      const x = 400;
      const template = tag\`${'${[x, () => { return x; const x = 1; }]}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);
    const runtimeValue = evaluateExpression<[number, () => number]>(
      runtimeHelperSource(result.code)
    );
    const candidateValue = evaluateExpression<[number, () => number]>(
      result.staticValueCandidates[0]!.source
    );

    expect(runtimeValue[0]).toBe(400);
    expect(candidateValue[0]).toBe(400);
    expect(runtimeValue[1]).toThrow(ReferenceError);
    expect(candidateValue[1]).toThrow(ReferenceError);
  });

  it('projects an imported destructuring reference without rewriting shadows', () => {
    const code = dedent`
      import { source } from './tokens';
      const { x } = source;
      const template = tag\`${'${'}[
        x,
        (x = 1) => x,
        ({ x }) => x,
        (value = x) => value,
        () => { return x; const x = 1; },
      ]}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);
    const candidate = result.staticValueCandidates[0]!;
    const runtimeValue = evaluateExpression<
      [
        number,
        (x?: number) => number,
        (value: { x: number }) => number,
        (value?: number) => number,
        () => number,
      ]
    >(runtimeHelperSource(result.code), ['x'], [400]);
    const candidateValue = evaluateExpression<
      [
        number,
        (x?: number) => number,
        (value: { x: number }) => number,
        (value?: number) => number,
        () => number,
      ]
    >(candidate.source, ['source'], [{ x: 400 }]);

    expect(candidate.imports).toEqual([
      {
        imported: 'source',
        local: 'source',
        source: './tokens',
      },
    ]);
    [runtimeValue, candidateValue].forEach((value) => {
      expect(value[0]).toBe(400);
      expect(value[1]()).toBe(1);
      expect(value[1](17)).toBe(17);
      expect(value[2]({ x: 23 })).toBe(23);
      expect(value[3]()).toBe(400);
      expect(value[4]).toThrow(ReferenceError);
    });
  });

  it.each([false, true])(
    'keeps switch discriminants outside case lexical scope with evaluate=%s',
    (evaluate) => {
      const code = dedent`
        function Component() {
          const x = 0;
          const template = tag\`${'${'}(() => {
            switch (x) {
              case 0:
                let x = 400;
                return x;
              default:
                return -1;
            }
          })()}\`;
          return template;
        }
      `;

      const result = collectOxcTemplateDependencies(code, filename, evaluate);

      expect(evaluateCollectorComponent<number>(result.code)).toBe(400);
    }
  );
});
