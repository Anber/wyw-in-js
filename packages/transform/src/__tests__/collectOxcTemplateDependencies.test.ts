import { evaluateOxcStaticExpression } from '../utils/collectOxcTemplateDependencies';

describe('evaluateOxcStaticExpression', () => {
  it('does not treat unresolved typeof operands as static undefined', () => {
    expect(
      evaluateOxcStaticExpression('typeof missingGlobal', '/test.ts')
    ).toBe(undefined);
    expect(
      evaluateOxcStaticExpression(
        "typeof missingGlobal ? 'fallback' : 'runtime'",
        '/test.ts'
      )
    ).toBe(undefined);
  });

  it('still treats process.env property access as build-time undefined', () => {
    expect(
      evaluateOxcStaticExpression('typeof process.env.NODE_ENV', '/test.ts')
    ).toBe('undefined');
  });

  it('preserves bitwise-not semantics without using a bitwise operator', () => {
    expect(evaluateOxcStaticExpression('~1', '/test.ts')).toBe(-2);
    expect(evaluateOxcStaticExpression('~2147483648', '/test.ts')).toBe(
      2147483647
    );
  });
});
