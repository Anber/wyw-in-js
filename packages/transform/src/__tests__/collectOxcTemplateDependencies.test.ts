import {
  evaluateOxcStaticExpression,
  evaluateOxcStaticExpressionAt,
} from '../utils/collectOxcTemplateDependencies';

describe('evaluateOxcStaticExpression', () => {
  it('folds typeof of undeclared globals to "undefined"', () => {
    // JS spec: `typeof undeclaredVar` returns 'undefined' regardless of
    // whether the symbol is declared. Folding this lets wyw collapse
    // canonical "is this build-time global defined?" guards like
    // `typeof __DEV__ !== 'undefined' && __DEV__` into their static
    // value when the user hasn't registered the global.
    expect(
      evaluateOxcStaticExpression('typeof missingGlobal', '/test.ts')
    ).toBe('undefined');
    expect(
      evaluateOxcStaticExpression(
        "typeof missingGlobal === 'undefined' ? 'fallback' : 'runtime'",
        '/test.ts'
      )
    ).toBe('fallback');
  });

  it('still treats process.env property access as build-time undefined', () => {
    expect(
      evaluateOxcStaticExpression('typeof process.env.NODE_ENV', '/test.ts')
    ).toBe('undefined');
    expect(
      evaluateOxcStaticExpression(
        "process.env.NODE_ENV === undefined ? 'fallback' : 'runtime'",
        '/test.ts'
      )
    ).toBe('fallback');
  });

  it('does not fold typeof declared dynamic locals as undeclared globals', () => {
    const code =
      "const local = window.foo;\nconst value = typeof local === 'undefined' ? 'fallback' : 'runtime';";
    const expression = "typeof local === 'undefined' ? 'fallback' : 'runtime'";
    const start = code.indexOf(expression);

    expect(
      evaluateOxcStaticExpressionAt(code, '/test.ts', {
        start,
        end: start + expression.length,
      })
    ).toBe(undefined);
  });

  it('preserves bitwise-not semantics without using a bitwise operator', () => {
    expect(evaluateOxcStaticExpression('~1', '/test.ts')).toBe(-2);
    expect(evaluateOxcStaticExpression('~2147483648', '/test.ts')).toBe(
      2147483647
    );
  });
});
