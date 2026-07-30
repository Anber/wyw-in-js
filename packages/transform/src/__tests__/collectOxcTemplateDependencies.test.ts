import type { Node } from 'oxc-parser';

import {
  evaluateOxcStaticExpression,
  evaluateOxcStaticExpressionAt,
} from '../utils/collectOxcTemplateDependencies';
import { evaluateStaticPropertyKey } from '../utils/collectOxcTemplateDependencies/staticEvaluationRuntime';
import { copyEnumerableOwnDataProperties } from '../utils/collectOxcTemplateDependencies/staticValues';
import type { ExtractionContext } from '../utils/collectOxcTemplateDependencies/types';

const evaluateLastExpression = (
  code: string,
  expression: string
): unknown | undefined => {
  const start = code.lastIndexOf(expression);
  return evaluateOxcStaticExpressionAt(code, '/test.ts', {
    end: start + expression.length,
    start,
  });
};

describe('evaluateOxcStaticExpression', () => {
  it('copies enumerable own data properties with exclusions', () => {
    let accessorReads = 0;
    const target = {};
    const source = Object.defineProperties(
      {},
      {
        excluded: {
          enumerable: true,
          get: () => {
            accessorReads += 1;
            return 'excluded';
          },
        },
        hidden: {
          enumerable: false,
          get: () => {
            accessorReads += 1;
            return 'hidden';
          },
        },
        included: {
          enumerable: true,
          value: 'included',
        },
      }
    );

    expect(
      copyEnumerableOwnDataProperties(
        target,
        source,
        new Set(['excluded']),
        'reject'
      )
    ).toBe(true);
    expect(target).toEqual({ included: 'included' });
    expect(accessorReads).toBe(0);

    Object.defineProperty(source, 'includedAccessor', {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return 'unsafe';
      },
    });
    expect(
      copyEnumerableOwnDataProperties(
        {},
        source,
        new Set(['excluded']),
        'reject'
      )
    ).toBe(false);
    expect(accessorReads).toBe(0);
  });

  it('defines a copied __proto__ as an own data property', () => {
    const target = {};
    const prototypeValue = { unsafe: true };
    const source = Object.defineProperty({}, '__proto__', {
      enumerable: true,
      value: prototypeValue,
    });

    expect(copyEnumerableOwnDataProperties(target, source)).toBe(true);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(target, '__proto__')).toMatchObject({
      enumerable: true,
      value: prototypeValue,
    });
  });

  it('copies enumerable symbols by default and ignores hidden symbols', () => {
    const copied = Symbol('copied');
    const hidden = Symbol('hidden');
    const source = Object.defineProperties(
      {},
      {
        [copied]: {
          enumerable: true,
          value: 304,
        },
        [hidden]: {
          enumerable: false,
          value: 400,
        },
      }
    );
    const target: Record<PropertyKey, unknown> = {};

    expect(copyEnumerableOwnDataProperties(target, source)).toBe(true);
    expect(target[copied]).toBe(304);
    expect(Object.hasOwn(target, hidden)).toBe(false);
  });

  it('rejects only enumerable symbols when copying object rest', () => {
    const enumerable = Symbol('enumerable');
    const hidden = Symbol('hidden');
    const hiddenOnly = Object.defineProperty({}, hidden, {
      enumerable: false,
      value: 304,
    });
    const withEnumerable = Object.defineProperty({}, enumerable, {
      enumerable: true,
      value: 400,
    });

    expect(
      copyEnumerableOwnDataProperties({}, hiddenOnly, undefined, 'reject')
    ).toBe(true);
    expect(
      copyEnumerableOwnDataProperties({}, withEnumerable, undefined, 'reject')
    ).toBe(false);
  });

  it('applies the enumerable-symbol policy through static object rest', () => {
    const symbol = Symbol('rest');
    const source = { included: 304 };
    Object.defineProperty(source, symbol, {
      configurable: true,
      enumerable: false,
      get: () => {
        throw new Error('non-enumerable symbols must be ignored');
      },
    });
    const project = () =>
      evaluateOxcStaticExpression(
        '(({ ...rest }) => rest)(source)',
        '/test.ts',
        new Map([['source', source]])
      );

    expect(project()).toEqual({ included: 304 });

    Object.defineProperty(source, symbol, { enumerable: true });
    expect(project()).toBeUndefined();
  });

  it('preserves enumerable symbols through static object spread', () => {
    const symbol = Symbol('spread');
    const source = Object.defineProperty({}, symbol, {
      enumerable: true,
      value: 304,
    });

    const result = evaluateOxcStaticExpression(
      '({ ...source })',
      '/test.ts',
      new Map([['source', source]])
    ) as Record<PropertyKey, unknown>;

    expect(result[symbol]).toBe(304);
  });

  it('resolves static property keys without duplicate computed evaluation', () => {
    const evaluateStatic = jest.fn((): unknown => 'resolved');
    const ctx = {} as ExtractionContext;
    const env = new Map<string, unknown>();
    const resolve = (key: Node, computed: boolean) =>
      evaluateStaticPropertyKey(key, computed, ctx, env, [], evaluateStatic);
    const identifierKey = {
      name: 'plain',
      type: 'Identifier',
    } as unknown as Node;

    expect(resolve(identifierKey, false)).toBe('plain');
    expect(evaluateStatic).toHaveBeenCalledTimes(0);

    const literalKey = {
      type: 'Literal',
      value: 'literal',
    } as unknown as Node;
    expect(resolve(literalKey, true)).toBe('literal');
    expect(evaluateStatic).toHaveBeenCalledTimes(0);

    const numericLiteralKey = {
      type: 'Literal',
      value: 4,
    } as unknown as Node;
    expect(resolve(numericLiteralKey, true)).toBe(4);
    expect(evaluateStatic).toHaveBeenCalledTimes(0);

    expect(resolve(identifierKey, true)).toBe('resolved');
    expect(evaluateStatic).toHaveBeenCalledTimes(1);

    evaluateStatic.mockReturnValue({});
    expect(resolve(identifierKey, true)).toBeNull();
    expect(evaluateStatic).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'computed object creation and read',
      "({ ['accent']: 'red' })['accent'];",
      "({ ['accent']: 'red' })['accent']",
      'red',
    ],
    [
      'computed root mutation replay',
      `
        const source = { width: 608 };
        source['width'] = 704;
        source['width'];
      `,
      "source['width']",
      704,
    ],
    [
      'computed string member calls',
      "'wyw'['toUpperCase']();",
      "'wyw'['toUpperCase']()",
      'WYW',
    ],
  ])('preserves %s', (_description, code, expression, expected) => {
    expect(evaluateLastExpression(code, expression)).toEqual(expected);
  });

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

  it.each(['let', 'const'])(
    'does not read a later %s initializer through the TDZ',
    (kind) => {
      expect(
        evaluateLastExpression(`value;\n${kind} value = 304;`, 'value')
      ).toBeUndefined();
    }
  );

  it('models a pre-declaration var binding as undefined', () => {
    expect(
      evaluateLastExpression('typeof value;\nvar value = 304;', 'typeof value')
    ).toBe('undefined');
    expect(
      evaluateLastExpression('value ?? 304;\nvar value = 400;', 'value ?? 304')
    ).toBe(304);
  });

  it('keeps function declarations hoisted before their source position', () => {
    const code = 'helper();\nfunction helper() { return 304; }';
    const start = code.indexOf('helper()');
    expect(
      evaluateOxcStaticExpressionAt(code, '/test.ts', {
        end: start + 'helper()'.length,
        start,
      })
    ).toBe(304);
  });

  it('models a hoisted function declaration as a function value', () => {
    const code = 'typeof helper;\nfunction helper() { return 304; }';
    const expression = 'typeof helper';
    const start = code.indexOf(expression);

    expect(
      evaluateOxcStaticExpressionAt(code, '/test.ts', {
        end: start + expression.length,
        start,
      })
    ).toBe('function');
  });

  it.each(['let', 'const'])(
    'fails closed for a function-local %s read before initialization',
    (kind) => {
      const code = `
        function run() {
          return value;
          ${kind} value = 304;
        }
        run();
      `;

      expect(evaluateLastExpression(code, 'run()')).toBeUndefined();
    }
  );

  it('models function-local var hoisting before its initializer', () => {
    const code = `
      function run() {
        return typeof value;
        var value = 304;
      }
      run();
    `;

    expect(evaluateLastExpression(code, 'run()')).toBe('undefined');
  });

  it('keeps a later function parameter in the TDZ during default evaluation', () => {
    const code = `
      function run(first = typeof second, second = 1) {
        return first;
      }
      run();
    `;

    expect(evaluateLastExpression(code, 'run()')).toBeUndefined();
  });

  it('makes an earlier function parameter available to a later default', () => {
    const code = `
      function run(first = 1, second = typeof first) {
        return second;
      }
      run();
    `;

    expect(evaluateLastExpression(code, 'run()')).toBe('number');
  });

  it('does not overwrite a parameter with an uninitialized var redeclaration', () => {
    const code = `
      function run(value) {
        var value;
        return value;
      }
      run(1);
    `;

    expect(evaluateLastExpression(code, 'run(1)')).toBe(1);
  });

  it('does not overwrite a defaulted parameter with an uninitialized var redeclaration', () => {
    const code = `
      function run(value = 1) {
        var value;
        return value;
      }
      run();
    `;

    expect(evaluateLastExpression(code, 'run()')).toBe(1);
  });

  it('initializes an uninitialized let declaration to undefined', () => {
    const code = `
      const value = 1;
      function run() {
        let value;
        return typeof value;
      }
      run();
    `;

    expect(evaluateLastExpression(code, 'run()')).toBe('undefined');
  });

  it('assigns an initialized var redeclaration over a parameter', () => {
    const code = `
      function run(value) {
        var value = 2;
        return value;
      }
      run(1);
    `;

    expect(evaluateLastExpression(code, 'run(1)')).toBe(2);
  });

  it('keeps body var bindings out of parameter default evaluation', () => {
    const code = `
      const source = 1;
      function run(value = source) {
        var source = 2;
        return value;
      }
      run();
    `;

    expect(evaluateLastExpression(code, 'run()')).toBe(1);
  });

  it('makes parameters and body var bindings visible in the function body', () => {
    const code = `
      const source = 1;
      function run(value = source) {
        var source = 2;
        return value + source;
      }
      run();
    `;

    expect(evaluateLastExpression(code, 'run()')).toBe(3);
  });

  it.each([
    `
      function run() {
        function helper() {
          return 304;
        }
        return helper();
      }
      run();
    `,
    `
      function run() {
        return helper();
        function helper() {
          return 304;
        }
      }
      run();
    `,
  ])('evaluates function-local hoisted declarations', (code) => {
    expect(evaluateLastExpression(code, 'run()')).toBe(304);
  });

  it('uses a named function expression self-binding instead of an outer binding', () => {
    const code = `
      const self = 304;
      const invoke = function self() {
        return typeof self === 'function';
      };
      invoke();
    `;

    expect(evaluateLastExpression(code, 'invoke()')).toBe(true);
  });

  it('fails closed for a function-local class TDZ', () => {
    const code = `
      const Value = 304;
      function run() {
        return Value;
        class Value {}
      }
      run();
    `;

    expect(evaluateLastExpression(code, 'run()')).toBeUndefined();
  });

  it('fails closed for a block-local class TDZ', () => {
    const code = `
      const Value = 304;
      {
        Value;
        class Value {}
      }
    `;
    const blockStart = code.indexOf('{');
    const start = code.indexOf('Value;', blockStart);

    expect(
      evaluateOxcStaticExpressionAt(code, '/test.ts', {
        end: start + 'Value'.length,
        start,
      })
    ).toBeUndefined();
  });

  it.each([
    `
      function value() {
        return 1;
      }
      value = () => 2;
      value();
    `,
    `
      let value = () => 1;
      value = () => 2;
      value();
    `,
  ])('does not fold a reassigned local callee', (code) => {
    expect(evaluateLastExpression(code, 'value()')).toBeUndefined();
  });

  it('keeps a local call before a later callee reassignment', () => {
    const code = `
      let value = () => 1;
      value();
      value = () => 2;
    `;

    expect(evaluateLastExpression(code, 'value()')).toBe(1);
  });

  it.each(['String', 'Number', 'Boolean'])(
    'does not use the %s call intrinsic when it is locally bound',
    (name) => {
      const expression = `${name}(1)`;
      expect(
        evaluateLastExpression(
          `const ${name} = custom;\n${expression};`,
          expression
        )
      ).toBeUndefined();
    }
  );

  it.each(['String', 'Number', 'Boolean'])(
    'does not use the %s constructor intrinsic when it is locally bound',
    (name) => {
      const expression = `new ${name}(1)`;
      expect(
        evaluateLastExpression(
          `const ${name} = custom;\n${expression};`,
          expression
        )
      ).toBeUndefined();
    }
  );

  it('does not treat a local process binding as build-time process.env', () => {
    const code = `
      const process = { env: { NODE_ENV: 'local' } };
      process.env.NODE_ENV;
    `;

    expect(evaluateLastExpression(code, 'process.env.NODE_ENV')).toBe('local');
  });

  it('does not fold a string method after its prototype is changed', () => {
    const code = `
      String.prototype.toUpperCase = () => 'mutated';
      'wyw'.toUpperCase();
    `;

    expect(evaluateLastExpression(code, "'wyw'.toUpperCase()")).toBeUndefined();
  });

  it.each([
    [
      'a local alias write',
      `
        const source = { width: 608 };
        const alias = source;
        alias.width = 704;
        source.width;
      `,
      'source.width',
    ],
    [
      'a nested alias write',
      `
        const source = { nested: { width: 608 } };
        const alias = source.nested;
        alias.width = 704;
        source.nested.width;
      `,
      'source.nested.width',
    ],
    [
      'a local mutator call',
      `
        const source = { width: 608 };
        function mutate(value) {
          value.width = 704;
        }
        mutate(source);
        source.width;
      `,
      'source.width',
    ],
    [
      'Object.assign',
      `
        const source = { width: 608 };
        Object.assign(source, { width: 704 });
        source.width;
      `,
      'source.width',
    ],
  ])(
    'does not stale-fold a root object after %s',
    (_description, code, expression) => {
      expect(evaluateLastExpression(code, expression)).toBeUndefined();
    }
  );

  it('replays a modeled direct root object mutation', () => {
    const code = `
      const source = { width: 608 };
      source.width = 704;
      source.width;
    `;

    expect(evaluateLastExpression(code, 'source.width')).toBe(704);
  });

  it('evaluates inline object destructuring projections', () => {
    const env = new Map<string, unknown>([
      [
        'theme',
        {
          accent: null,
          dimensions: { height: 171, width: 304 },
          extra: 'kept',
        },
      ],
      ['fallback', 'red'],
      ['key', 'accent'],
    ]);

    const project = (binding: 'color' | 'height' | 'rest' | 'w') =>
      evaluateOxcStaticExpression(
        `(({
          dimensions: { width: w, height = 100 },
          [key]: color = fallback,
          ...rest
        }) => ${binding})(theme)`,
        '/test.ts',
        env
      );

    expect([
      project('w'),
      project('height'),
      project('color'),
      project('rest'),
    ]).toEqual([304, 171, null, { extra: 'kept' }]);
  });

  it('evaluates inline array destructuring projections with holes and rest', () => {
    const project = (binding: 'first' | 'tail' | 'third') =>
      evaluateOxcStaticExpression(
        `(([first, , third = 8, ...tail]) => ${binding})([1, 2])`,
        '/test.ts'
      );

    expect([project('first'), project('third'), project('tail')]).toEqual([
      1,
      8,
      [],
    ]);
  });

  it.each([
    ['object', '(({ width }) => width)(source)', { width: 304 }, 'width'],
    ['array', '(([width]) => width)(source)', [304], '0'],
  ] as const)(
    'rejects a proxied %s projection without invoking traps',
    (_kind, expression, target, projectedKey) => {
      const trapCalls: string[] = [];
      const source = new Proxy(target, {
        get: (proxyTarget, key, receiver) => {
          trapCalls.push(`get:${String(key)}`);
          return String(key) === projectedKey
            ? 400
            : Reflect.get(proxyTarget, key, receiver);
        },
        getOwnPropertyDescriptor: (proxyTarget, key) => {
          trapCalls.push(`getOwnPropertyDescriptor:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(proxyTarget, key);
        },
        getPrototypeOf: (proxyTarget) => {
          trapCalls.push('getPrototypeOf');
          return Reflect.getPrototypeOf(proxyTarget);
        },
        has: (proxyTarget, key) => {
          trapCalls.push(`has:${String(key)}`);
          return Reflect.has(proxyTarget, key);
        },
        ownKeys: (proxyTarget) => {
          trapCalls.push('ownKeys');
          return Reflect.ownKeys(proxyTarget);
        },
      });

      expect(
        evaluateOxcStaticExpression(
          expression,
          '/test.ts',
          new Map([['source', source]])
        )
      ).toBeUndefined();
      expect(trapCalls).toEqual([]);

      expect(Reflect.get(source, projectedKey)).toBe(400);
      expect(trapCalls).toEqual([`get:${projectedKey}`]);
    }
  );

  it('keeps accessor-backed object patterns on the evaluator path', () => {
    let excludedReads = 0;
    let includedReads = 0;
    const source = {};
    Object.defineProperties(source, {
      excluded: {
        enumerable: true,
        get: () => {
          excludedReads += 1;
          return 'excluded';
        },
      },
      included: {
        enumerable: true,
        get: () => {
          includedReads += 1;
          return 'included';
        },
      },
    });

    expect(
      evaluateOxcStaticExpression(
        '(({ excluded, ...rest }) => rest)(source)',
        '/test.ts',
        new Map([['source', source]])
      )
    ).toBeUndefined();
    expect(excludedReads).toBe(0);
    expect(includedReads).toBe(0);
  });

  it('rejects inherited object accessors without invoking them', () => {
    let reads = 0;
    const prototype = Object.create(Object.prototype, {
      value: {
        configurable: true,
        enumerable: true,
        get: () => {
          reads += 1;
          return 304;
        },
      },
    });
    const source = Object.create(prototype);

    expect(
      evaluateOxcStaticExpression(
        '(({ value }) => value)(source)',
        '/test.ts',
        new Map([['source', source]])
      )
    ).toBeUndefined();
    expect(reads).toBe(0);
  });

  it('rejects null object prototypes during projection', () => {
    const source = Object.create(null);
    Object.defineProperty(source, 'value', {
      configurable: true,
      enumerable: true,
      value: 304,
      writable: true,
    });

    expect(
      evaluateOxcStaticExpression(
        '(({ value }) => value)(source)',
        '/test.ts',
        new Map([['source', source]])
      )
    ).toBeUndefined();
  });

  it('keeps accessor-backed array patterns on the evaluator path', () => {
    let reads = 0;
    const source = [0, 2];
    Object.defineProperty(source, 0, {
      get: () => {
        reads += 1;
        return 1;
      },
    });

    expect(
      evaluateOxcStaticExpression(
        '(([, second]) => second)(source)',
        '/test.ts',
        new Map([['source', source]])
      )
    ).toBeUndefined();
    expect(reads).toBe(0);
  });

  it('rejects inherited array accessors without invoking them', () => {
    let reads = 0;
    const prototype = Object.create(Array.prototype, {
      0: {
        configurable: true,
        get: () => {
          reads += 1;
          return 304;
        },
      },
    });
    const source = new Array(1);
    Object.setPrototypeOf(source, prototype);

    expect(
      evaluateOxcStaticExpression(
        '(([value]) => value)(source)',
        '/test.ts',
        new Map([['source', source]])
      )
    ).toBeUndefined();
    expect(reads).toBe(0);
  });

  it.each([
    '(({ a = typeof b, b = 1 }) => a)({})',
    '(([a = typeof b, b = 1]) => a)([])',
    '(({ [typeof b]: a = 1, b = 1 }) => a)({})',
  ])(
    'keeps a later destructuring sibling in the TDZ while evaluating %s',
    (expression) => {
      expect(
        evaluateOxcStaticExpression(expression, '/test.ts')
      ).toBeUndefined();
    }
  );

  it.each([
    ['(({ a = 1, b = typeof a }) => b)({})', 'number'],
    ['(([a = 1, b = typeof a]) => b)([])', 'number'],
    ["(({ a = 'width', [a]: b = 1 }) => b)({})", 1],
  ])(
    'makes an earlier destructuring sibling available to %s',
    (expression, expected) => {
      expect(evaluateOxcStaticExpression(expression, '/test.ts')).toBe(
        expected
      );
    }
  );

  it('does not evaluate arbitrary inline functions as projections', () => {
    expect(
      evaluateOxcStaticExpression(
        '(() => { return value; const value = 1; })()',
        '/test.ts'
      )
    ).toBeUndefined();
    expect(
      evaluateOxcStaticExpression('((value) => value)(1)', '/test.ts')
    ).toBeUndefined();
  });

  it('keeps destructuring defaults fail-closed for TDZ references', () => {
    expect(
      evaluateOxcStaticExpression(
        '(({ first = 1, second = first }) => second)({})',
        '/test.ts'
      )
    ).toBe(1);
    expect(
      evaluateOxcStaticExpression(
        '(({ first = second, second = 2 }) => first)({})',
        '/test.ts'
      )
    ).toBeUndefined();
    expect(
      evaluateOxcStaticExpression(
        '(({ value = value }) => value)({})',
        '/test.ts'
      )
    ).toBeUndefined();
    expect(
      evaluateOxcStaticExpression(
        '(({ value = value }) => value)({})',
        '/test.ts',
        new Map([['value', 42]])
      )
    ).toBeUndefined();
  });
});
