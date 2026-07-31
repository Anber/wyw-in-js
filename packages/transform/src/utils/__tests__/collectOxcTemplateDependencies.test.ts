/* eslint-env jest */
import dedent from 'dedent';

import { ValueType } from '@wyw-in-js/shared';

import {
  collectOxcTemplateDependencies,
  evaluateOxcStaticExpression,
  evaluateOxcStaticExpressionAt,
  isOxcStaticSerializableValue,
} from '../collectOxcTemplateDependencies';
import {
  cloneStaticValue,
  literalCode,
} from '../collectOxcTemplateDependencies/staticValues';
import {
  analyzeProgram,
  getRootMutationHazards,
  parseOxc,
  resolveBindingAt,
  toMutationBindingKey,
} from '../collectOxcTemplateDependencies/scopeAnalysis';

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

  it('records imported static candidates through hoisted local declarations', () => {
    const code = dedent`
      import { themeVars } from './tokens';

      const gradient = \`linear-gradient(${'${themeVars.from}'}, ${'${themeVars.to}'})\`;
      const template = tag\`${'${gradient}'}\`;
    `;

    const targetStart = code.indexOf('`${gradient}`');
    const result = collectOxcTemplateDependencies(code, filename, true, [
      { start: targetStart, end: targetStart + '`${gradient}`'.length },
    ]);

    expect(result.staticValueCandidates).toEqual([
      {
        imports: [
          {
            imported: 'themeVars',
            local: 'themeVars',
            source: './tokens',
          },
        ],
        name: '_exp',
        source: '`linear-gradient(${themeVars.from}, ${themeVars.to})`',
      },
    ]);
    expect(result.expressionValues[0]).toMatchObject({
      importedFrom: ['./tokens'],
      source: 'gradient',
    });
  });

  it('projects imported values through complete destructuring patterns', () => {
    const code = dedent`
      import { fallback, key, theme } from './tokens';

      const {
        dimensions: { width: w, height = 100 },
        tuple: [first, , third = 8, ...tail],
        [key]: color = fallback,
        ...rest
      } = theme;

      const template = tag\`
        ${'${w}'}
        ${'${height}'}
        ${'${first}'}
        ${'${third}'}
        ${'${tail}'}
        ${'${color}'}
        ${'${rest}'}
      \`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);
    const env = new Map<string, unknown>([
      ['fallback', 'red'],
      ['key', 'accent'],
      [
        'theme',
        {
          accent: null,
          dimensions: { width: 304 },
          extra: 'kept',
          tuple: [1, 2],
        },
      ],
    ]);

    expect(
      result.staticValueCandidates.map((candidate) =>
        evaluateOxcStaticExpression(candidate.source, filename, env)
      )
    ).toEqual([304, 100, 1, 8, [], null, { extra: 'kept' }]);
    expect(
      result.staticValueCandidates.every(
        (candidate) => candidate.source !== 'theme'
      )
    ).toBe(true);
    expect(
      result.staticValueCandidates.map((candidate) =>
        candidate.imports.map(({ imported }) => imported).sort()
      )
    ).toEqual(Array.from({ length: 7 }, () => ['fallback', 'key', 'theme']));
  });

  it('creates computed __proto__ object keys as own data properties', () => {
    const value = evaluateOxcStaticExpression(
      "({ ['__proto__']: { marker: 'own' } })",
      filename
    ) as Record<string, unknown>;

    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(value, '__proto__')).toEqual({
      configurable: true,
      enumerable: true,
      value: { marker: 'own' },
      writable: true,
    });
  });

  it('creates shorthand __proto__ keys as own data properties', () => {
    const marker = { marker: 'own' };
    const value = evaluateOxcStaticExpression(
      '({ __proto__ })',
      filename,
      new Map([['__proto__', marker]])
    ) as Record<string, unknown>;

    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(value, '__proto__')).toEqual({
      configurable: true,
      enumerable: true,
      value: marker,
      writable: true,
    });
  });

  it('copies spread __proto__ keys as own data properties', () => {
    const marker = { marker: 'spread' };
    const source = Object.create(null);
    Object.defineProperty(source, '__proto__', {
      configurable: true,
      enumerable: true,
      value: marker,
      writable: true,
    });

    const value = evaluateOxcStaticExpression(
      '({ ...source })',
      filename,
      new Map([['source', source]])
    ) as Record<string, unknown>;

    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(value, '__proto__')).toEqual({
      configurable: true,
      enumerable: true,
      value: marker,
      writable: true,
    });
  });

  it('does not invoke enumerable accessors while evaluating object spread', () => {
    let reads = 0;
    const source = {};
    Object.defineProperty(source, 'value', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return 304;
      },
    });

    expect(
      evaluateOxcStaticExpression(
        '({ ...source })',
        filename,
        new Map([['source', source]])
      )
    ).toBeUndefined();
    expect(reads).toBe(0);
  });

  it.each([
    [
      'Object.prototype',
      'Object.prototype.width = 400;',
      'const { width = 304 } = {};',
    ],
    [
      'an Object.prototype alias',
      'const objectPrototype = Object.prototype; objectPrototype.width = 400;',
      'const { width = 304 } = {};',
    ],
    [
      'a mutable Object.prototype alias',
      'let objectPrototype = Object.prototype; objectPrototype.width = 400;',
      'const { width = 304 } = {};',
    ],
    [
      'an opaque Object prototype result',
      'const objectPrototype = Object.getPrototypeOf({}); objectPrototype.width = 400;',
      'const { width = 304 } = {};',
    ],
    [
      'Array.prototype[Symbol.iterator]',
      'Array.prototype[Symbol.iterator] = function* iterator() { yield 400; };',
      'const [width] = [304];',
    ],
    [
      'an aliased Symbol.iterator key',
      dedent`
        const iterator = Symbol.iterator;
        Array.prototype[iterator] = function* customIterator() { yield 400; };
      `,
      'const [width] = [304];',
    ],
    [
      'a mutable Array.prototype alias',
      dedent`
        let arrayPrototype = Array.prototype;
        arrayPrototype[Symbol.iterator] = function* customIterator() { yield 400; };
      `,
      'const [width] = [304];',
    ],
    [
      'an opaque Array prototype result',
      dedent`
        const arrayPrototype = Object.getPrototypeOf([]);
        arrayPrototype[Symbol.iterator] = function* customIterator() { yield 400; };
      `,
      'const [width] = [304];',
    ],
    [
      'an inherited Array.prototype value for an array hole',
      'Array.prototype[0] = 400;',
      dedent`
        const source = [];
        source.length = 1;
        const [width = 304] = source;
      `,
    ],
    [
      'an inherited Object.prototype value for an array hole',
      'Object.prototype[0] = 400;',
      dedent`
        const source = [];
        source.length = 1;
        const [width = 304] = source;
      `,
    ],
  ])(
    'falls back when %s is mutated before destructuring',
    (_intrinsic, mutation, declaration) => {
      const code = dedent`
        ${mutation}
        ${declaration}
        width;
      `;
      const expressionStart = code.lastIndexOf('width');

      expect(
        evaluateOxcStaticExpressionAt(code, filename, {
          end: expressionStart + 'width'.length,
          start: expressionStart,
        })
      ).toBeUndefined();
    }
  );

  it('still evaluates a dense array projection with the default iterator', () => {
    const code = dedent`
      const source = [400];
      const [width = 304] = source;
      width;
    `;
    const expressionStart = code.lastIndexOf('width');

    expect(
      evaluateOxcStaticExpressionAt(code, filename, {
        end: expressionStart + 'width'.length,
        start: expressionStart,
      })
    ).toBe(400);
  });

  it('clones array holes, own properties, and graph aliases without reading accessors', () => {
    const sharedPrototype = { inherited: true };
    const shared = Object.assign(Object.create(sharedPrototype), { value: 1 });
    const arrayPrototype = Object.create(Array.prototype);
    const source: unknown[] = new Array(4);
    Object.setPrototypeOf(source, arrayPrototype);
    let accessorReads = 0;
    const getter = () => {
      accessorReads += 1;
      return shared;
    };

    source[1] = shared;
    Object.defineProperties(source, {
      accessor: {
        configurable: true,
        enumerable: true,
        get: getter,
      },
      named: {
        configurable: true,
        enumerable: true,
        value: shared,
        writable: true,
      },
      self: {
        configurable: true,
        enumerable: true,
        value: source,
        writable: true,
      },
    });

    const cloned = cloneStaticValue(source) as unknown[] & {
      accessor: unknown;
      named: unknown;
      self: unknown;
    };

    expect(accessorReads).toBe(0);
    expect(cloned).not.toBe(source);
    expect(Object.getPrototypeOf(cloned)).toBe(arrayPrototype);
    expect(cloned).toHaveLength(4);
    expect(0 in cloned).toBe(false);
    expect(1 in cloned).toBe(true);
    expect(2 in cloned).toBe(false);
    expect(3 in cloned).toBe(false);
    expect(cloned.named).toBe(cloned[1]);
    expect(Object.getPrototypeOf(cloned.named)).toBe(sharedPrototype);
    expect(cloned.self).toBe(cloned);
    expect(Object.getOwnPropertyDescriptor(cloned, 'accessor')?.get).toBe(
      getter
    );
    expect(accessorReads).toBe(0);
  });

  it('rejects direct and nested proxies while cloning without invoking traps', () => {
    const trapCalls: string[] = [];
    const proxy = new Proxy(
      { width: 304 },
      {
        get: (target, key, receiver) => {
          trapCalls.push(`get:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor: (target, key) => {
          trapCalls.push(`getOwnPropertyDescriptor:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf: (target) => {
          trapCalls.push('getPrototypeOf');
          return Reflect.getPrototypeOf(target);
        },
        has: (target, key) => {
          trapCalls.push(`has:${String(key)}`);
          return Reflect.has(target, key);
        },
        ownKeys: (target) => {
          trapCalls.push('ownKeys');
          return Reflect.ownKeys(target);
        },
      }
    );

    expect(cloneStaticValue(proxy)).toBeUndefined();
    expect(cloneStaticValue({ nested: proxy })).toBeUndefined();
    expect(trapCalls).toEqual([]);
  });

  it('rejects nested proxies while generating literals without invoking traps', () => {
    const trapCalls: string[] = [];
    const proxy = new Proxy(
      { width: 304 },
      {
        get: (target, key, receiver) => {
          trapCalls.push(`get:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor: (target, key) => {
          trapCalls.push(`getOwnPropertyDescriptor:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf: (target) => {
          trapCalls.push('getPrototypeOf');
          return Reflect.getPrototypeOf(target);
        },
        ownKeys: (target) => {
          trapCalls.push('ownKeys');
          return Reflect.ownKeys(target);
        },
      }
    );
    const value = { nested: { proxy } };

    expect(literalCode(value)).toBeNull();
    expect(isOxcStaticSerializableValue(value)).toBe(false);
    expect(trapCalls).toEqual([]);
  });

  it('rejects a proxy nested in an object-rest result without invoking traps', () => {
    const trapCalls: string[] = [];
    const proxy = new Proxy(
      { width: 304 },
      {
        get: (target, key, receiver) => {
          trapCalls.push(`get:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor: (target, key) => {
          trapCalls.push(`getOwnPropertyDescriptor:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf: (target) => {
          trapCalls.push('getPrototypeOf');
          return Reflect.getPrototypeOf(target);
        },
        ownKeys: (target) => {
          trapCalls.push('ownKeys');
          return Reflect.ownKeys(target);
        },
      }
    );
    const result = evaluateOxcStaticExpression(
      '(({ omitted, ...rest }) => rest)(source)',
      filename,
      new Map([
        [
          'source',
          {
            nested: proxy,
            omitted: true,
          },
        ],
      ])
    );

    expect(result).not.toBeUndefined();
    expect(literalCode(result)).toBeNull();
    expect(isOxcStaticSerializableValue(result)).toBe(false);
    expect(trapCalls).toEqual([]);
  });

  it.each([
    [
      'object',
      () => {
        const value: { self?: unknown } = {};
        value.self = value;
        return value;
      },
    ],
    [
      'array',
      () => {
        const value: unknown[] = [];
        value.push(value);
        return value;
      },
    ],
  ] as const)('rejects a cyclic %s without throwing', (_kind, createValue) => {
    const value = createValue();

    expect(() => literalCode(value)).not.toThrow();
    expect(literalCode(value)).toBeNull();
    expect(isOxcStaticSerializableValue(value)).toBe(false);
  });

  it('rejects accessors without reading them', () => {
    let accessorReads = 0;
    const nested = {};
    Object.defineProperty(nested, 'width', {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return 304;
      },
    });
    const value = { nested };

    expect(literalCode(value)).toBeNull();
    expect(isOxcStaticSerializableValue(value)).toBe(false);
    expect(accessorReads).toBe(0);
  });

  it('fails closed on own accessor member reads without invoking them', () => {
    let accessorReads = 0;
    const source = {};
    Object.defineProperty(source, 'width', {
      configurable: true,
      get: () => {
        accessorReads += 1;
        return 304;
      },
    });

    expect(
      evaluateOxcStaticExpression(
        'source.width',
        filename,
        new Map([['source', source]])
      )
    ).toBeUndefined();
    expect(accessorReads).toBe(0);
  });

  it('fails closed on inherited accessor member reads without invoking them', () => {
    let accessorReads = 0;
    const prototype = {};
    Object.defineProperty(prototype, 'width', {
      configurable: true,
      get: () => {
        accessorReads += 1;
        return 304;
      },
    });
    const source = Object.create(prototype);

    expect(
      evaluateOxcStaticExpression(
        'source.width',
        filename,
        new Map([['source', source]])
      )
    ).toBeUndefined();
    expect(accessorReads).toBe(0);
  });

  it('fails closed on a nested accessor after destructuring without invoking it', () => {
    let accessorReads = 0;
    const nested = {};
    Object.defineProperty(nested, 'width', {
      configurable: true,
      get: () => {
        accessorReads += 1;
        return 304;
      },
    });
    const code = dedent`
      const { nested } = source;
      nested.width;
    `;
    const expression = 'nested.width';
    const expressionStart = code.lastIndexOf(expression);

    expect(
      evaluateOxcStaticExpressionAt(
        code,
        filename,
        {
          end: expressionStart + expression.length,
          start: expressionStart,
        },
        new Map([['source', { nested }]])
      )
    ).toBeUndefined();
    expect(accessorReads).toBe(0);
  });

  it('rejects proxied member reads without invoking traps', () => {
    const trapCalls: string[] = [];
    const source = new Proxy(
      { width: 304 },
      {
        get: (target, key, receiver) => {
          trapCalls.push(`get:${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor: (target, key) => {
          trapCalls.push(`getOwnPropertyDescriptor:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }
    );

    expect(
      evaluateOxcStaticExpression(
        'source.width',
        filename,
        new Map([['source', source]])
      )
    ).toBeUndefined();
    expect(trapCalls).toEqual([]);
  });

  it('reads plain own data members directly and after destructuring', () => {
    const source = { nested: { width: 304 }, width: 400 };

    expect(
      evaluateOxcStaticExpression(
        'source.width',
        filename,
        new Map([['source', source]])
      )
    ).toBe(400);

    const code = dedent`
      const { nested } = source;
      nested.width;
    `;
    const expression = 'nested.width';
    const expressionStart = code.lastIndexOf(expression);
    expect(
      evaluateOxcStaticExpressionAt(
        code,
        filename,
        {
          end: expressionStart + expression.length,
          start: expressionStart,
        },
        new Map([['source', source]])
      )
    ).toBe(304);
  });

  it.each([
    'value == 1',
    'value != 1',
    'value < 1',
    'value + 1',
    'value - 1',
    '+value',
    '`${value}`',
    'String(value)',
    'Number(value)',
    'new String(value)',
    'new Number(value)',
    'new Boolean(value)',
  ])(
    'fails closed for object coercion in %s without invoking conversion hooks',
    (expression) => {
      let coercions = 0;
      const value = {
        [Symbol.toPrimitive]: () => {
          coercions += 1;
          return 1;
        },
        toString: () => {
          coercions += 1;
          return '1';
        },
        valueOf: () => {
          coercions += 1;
          return 1;
        },
      };

      expect(
        evaluateOxcStaticExpression(
          expression,
          filename,
          new Map([['value', value]])
        )
      ).toBeUndefined();
      expect(coercions).toBe(0);
    }
  );

  it.each([
    ["'1' == 1", true],
    ["'1' != 1", false],
    ['1 < 2', true],
    ["'a' + 1", 'a1'],
    ['1 - 2', -1],
    ['String(1)', '1'],
    ["Number('2')", 2],
    ['`${1}`', '1'],
  ])(
    'still evaluates primitive-only coercion in %s',
    (expression, expected) => {
      expect(evaluateOxcStaticExpression(expression, filename)).toBe(expected);
    }
  );

  it.each([
    'new String(1)',
    'new Number(1)',
    'new Boolean(1)',
    'typeof new String(1)',
    'typeof new Number(1)',
    'typeof new Boolean(1)',
  ])(
    'fails closed for wrapper-constructor value semantics in %s',
    (expression) => {
      expect(evaluateOxcStaticExpression(expression, filename)).toBeUndefined();
    }
  );

  it('keeps plain Boolean conversion of an object hook-free', () => {
    let coercions = 0;
    const value = {
      [Symbol.toPrimitive]: () => {
        coercions += 1;
        return 0;
      },
    };
    const env = new Map<string, unknown>([['value', value]]);

    expect(evaluateOxcStaticExpression('Boolean(value)', filename, env)).toBe(
      true
    );
    expect(coercions).toBe(0);
  });

  it.each([
    ['object', 'non-writable', false, true],
    ['object', 'non-configurable', true, false],
    ['array', 'non-writable', false, true],
    ['array', 'non-configurable', true, false],
  ] as const)(
    'rejects a %s with a %s data property',
    (kind, _descriptorKind, writable, configurable) => {
      const value: Record<string, unknown> | unknown[] =
        kind === 'array' ? [] : {};
      Object.defineProperty(value, kind === 'array' ? '0' : 'width', {
        configurable,
        enumerable: true,
        value: 304,
        writable,
      });

      expect(literalCode(value)).toBeNull();
      expect(isOxcStaticSerializableValue(value)).toBe(false);
    }
  );

  it.each([
    ['a function value', { nested: { value: () => 304 } }],
    ['a symbol value', { nested: { value: Symbol('width') } }],
    ['an exotic value', { nested: { value: new Date(0) } }],
  ])('rejects %s from plain-data literals', (_kind, value) => {
    expect(literalCode(value)).toBeNull();
    expect(isOxcStaticSerializableValue(value)).toBe(false);
  });

  it('rejects symbol keys from plain-data literals', () => {
    const value = { width: 304 };
    Object.defineProperty(value, Symbol('metadata'), {
      enumerable: true,
      value: 'unsafe',
    });

    expect(literalCode(value)).toBeNull();
    expect(isOxcStaticSerializableValue(value)).toBe(false);
  });

  it('allows safe shared aliases and normal nested plain data', () => {
    const shared = { unit: 'px' };
    const value = {
      aliases: [shared, shared],
      theme: {
        enabled: true,
        sizes: [0, 4, 8],
      },
    };

    expect(literalCode(value)).toBe(
      '({"aliases":[{"unit":"px"},{"unit":"px"}],"theme":{"enabled":true,"sizes":[0,4,8]}})'
    );
    expect(isOxcStaticSerializableValue(value)).toBe(true);
  });

  it('emits an own __proto__ data key without changing the prototype', () => {
    const value = {};
    Object.defineProperty(value, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { marker: 'own' },
      writable: true,
    });

    const code = literalCode(value);
    expect(code).toBe('({["__proto__"]:{"marker":"own"}})');

    const roundTripped = evaluateOxcStaticExpression(code!, filename) as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(roundTripped)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(roundTripped, '__proto__')).toEqual({
      configurable: true,
      enumerable: true,
      value: { marker: 'own' },
      writable: true,
    });
  });

  it('rejects array holes instead of materializing them as null', () => {
    const value = [304];
    value[2] = 400;

    expect(literalCode(value)).toBeNull();
    expect(isOxcStaticSerializableValue(value)).toBe(false);
  });

  it.each([
    ['object', '({ ...source })', { width: 304 }],
    ['array', '[...source]', [304]],
  ] as const)(
    'rejects a proxied %s spread without invoking traps',
    (_kind, expression, target) => {
      const trapCalls: string[] = [];
      const source = new Proxy(target, {
        get: (proxyTarget, key, receiver) => {
          trapCalls.push(`get:${String(key)}`);
          return Reflect.get(proxyTarget, key, receiver);
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
          filename,
          new Map([['source', source]])
        )
      ).toBeUndefined();
      expect(trapCalls).toEqual([]);
    }
  );

  it.each(['getter', 'custom iterator'] as const)(
    'rejects an array spread with an own iterator %s without invoking it',
    (kind) => {
      let iteratorCalls = 0;
      const source = [304, 400];
      const customIterator = () => {
        iteratorCalls += 1;
        return [704][Symbol.iterator]();
      };
      Object.defineProperty(
        source,
        Symbol.iterator,
        kind === 'getter'
          ? {
              configurable: true,
              get: () => {
                iteratorCalls += 1;
                return customIterator;
              },
            }
          : {
              configurable: true,
              value: customIterator,
            }
      );

      expect(
        evaluateOxcStaticExpression(
          '[...source]',
          filename,
          new Map([['source', source]])
        )
      ).toBeUndefined();
      expect(iteratorCalls).toBe(0);
    }
  );

  it('falls back on array spread after a source-level iterator mutation', () => {
    const expression = '[...[304]]';
    const code = dedent`
      Array.prototype[Symbol.iterator] = function* customIterator() {
        yield 704;
      };
      ${expression};
    `;
    const expressionStart = code.lastIndexOf(expression);

    expect(
      evaluateOxcStaticExpressionAt(code, filename, {
        end: expressionStart + expression.length,
        start: expressionStart,
      })
    ).toBeUndefined();
  });

  it('spreads a normal plain-data array without invoking user code', () => {
    expect(
      evaluateOxcStaticExpression(
        '[...source]',
        filename,
        new Map([['source', [304, 400]]])
      )
    ).toEqual([304, 400]);
  });

  it.each([
    ['a modeled const write', 'source.width = 400;', 'const'],
    ['a modeled let update', 'source.width++;', 'let'],
    [
      'an opaque mutation hazard',
      'Object.assign(source, { width: 400 });',
      'const',
    ],
  ])(
    'falls back instead of replaying %s across a lexical TDZ',
    (_kind, mutation, declarationKind) => {
      const code = dedent`
        ${mutation}
        ${declarationKind} source = { width: 304 };
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      `;

      const result = collectOxcTemplateDependencies(code, filename, true);

      expect(result.staticValues).toEqual([]);
      expect(result.staticValueCandidates).toEqual([]);
      expect(result.dependencyNames).toEqual(['width']);
    }
  );

  it.each([
    'const { a = typeof b, b = 1 } = {};',
    'const [a = typeof b, b = 1] = [];',
    'const { [typeof b]: a = 1, b = 1 } = {};',
  ])(
    'does not fold a default or computed key across a destructuring sibling TDZ: %s',
    (declaration) => {
      const result = collectOxcTemplateDependencies(
        dedent`
          ${declaration}
          const template = tag\`${'${a}'}\`;
        `,
        filename,
        true
      );

      expect(result.staticValues).toEqual([]);
      expect(result.staticValueCandidates).toHaveLength(1);
      expect(
        evaluateOxcStaticExpression(
          result.staticValueCandidates[0]!.source,
          filename
        )
      ).toBeUndefined();
      expect(result.dependencyNames).toEqual(['a']);
    }
  );

  it.each([
    'const { a = 1, b = typeof a } = {};',
    'const [a = 1, b = typeof a] = [];',
    "const { a = 'width', [a]: b = 1 } = {};",
  ])(
    'folds a destructuring reference to an earlier initialized sibling: %s',
    (declaration) => {
      const result = collectOxcTemplateDependencies(
        dedent`
          ${declaration}
          const template = tag\`${'${b}'}\`;
        `,
        filename,
        true
      );

      expect(result.staticValues).toEqual([]);
      expect(result.staticValueCandidates).toHaveLength(1);
      expect(
        evaluateOxcStaticExpression(
          result.staticValueCandidates[0]!.source,
          filename
        )
      ).toBe(declaration.includes("a = 'width'") ? 1 : 'number');
    }
  );

  it.each([
    ['a let assignment', 'let value = 304;\nvalue = 400;'],
    ['a let update', 'let value = 303;\nvalue++;'],
    ['a var assignment', 'var value = 304;\nvalue = 400;'],
    ['a var update', 'var value = 303;\nvalue++;'],
  ])('does not fold the initializer across %s', (_description, declaration) => {
    const result = collectOxcTemplateDependencies(
      dedent`
          ${declaration}
          const template = tag\`${'${value}'}\`;
        `,
      filename,
      true
    );

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['value']);
  });

  it('keeps a scalar snapshot before a later reassignment', () => {
    const result = collectOxcTemplateDependencies(
      dedent`
        let value = 304;
        const template = tag\`${'${value}'}\`;
        value = 400;
      `,
      filename,
      true
    );

    expect(result.staticValues).toEqual([{ name: '_exp', value: 304 }]);
    expect(result.staticValueCandidates).toEqual([]);
  });

  it('evaluates local destructuring at the declaration snapshot', () => {
    const code = dedent`
      const source = { after: 10, before: 1 };
      source.before = 2;
      const { after, before } = source;
      source.after = 11;
      source.before = 3;

      const template = tag\`${'${before}'} ${'${after}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([
      { name: '_exp', value: 2 },
      { name: '_exp2', value: 10 },
    ]);
    expect(result.staticValueCandidates).toEqual([]);
  });

  it('projects destructured bindings through derived local constants', () => {
    const code = dedent`
      import { theme } from './tokens';

      const { width } = theme;
      const doubled = width * 2;
      const template = tag\`${'${doubled}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);
    const [candidate] = result.staticValueCandidates;

    expect(candidate?.imports).toEqual([
      {
        imported: 'theme',
        local: 'theme',
        source: './tokens',
      },
    ]);
    expect(
      evaluateOxcStaticExpression(
        candidate!.source,
        filename,
        new Map([['theme', { width: 304 }]])
      )
    ).toBe(608);
  });

  it('keeps repeated destructuring of the same static source analyzable', () => {
    const code = dedent`
      import { theme } from './tokens';

      const { width } = theme;
      const { height } = theme;
      const template = tag\`${'${width}'} ${'${height}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);
    const env = new Map<string, unknown>([
      ['theme', { height: 171, width: 304 }],
    ]);

    expect(
      result.staticValueCandidates.map((candidate) =>
        evaluateOxcStaticExpression(candidate.source, filename, env)
      )
    ).toEqual([304, 171]);
  });

  it('preserves shared object identity across destructured bindings', () => {
    const code = dedent`
      const shared = { value: 1 };
      const source = { first: shared, second: shared };
      const { first, second } = source;
      const template = tag\`${'${first === second}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([{ name: '_exp', value: true }]);
    expect(result.staticValueCandidates).toEqual([]);
  });

  it('preserves identity with an immutable source binding', () => {
    const code = dedent`
      const shared = { value: 1 };
      const source = { selected: shared };
      const { selected } = source;
      const template = tag\`${'${selected === shared}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([{ name: '_exp', value: true }]);
    expect(result.staticValueCandidates).toEqual([]);
  });

  it('ignores mutations that happen after an identity comparison', () => {
    const code = dedent`
      const shared = { value: 1 };
      const source = { first: shared, second: shared };
      const { first, second } = source;
      const template = tag\`${'${first === second}'}\`;
      first.value = 2;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([{ name: '_exp', value: true }]);
    expect(result.staticValueCandidates).toEqual([]);
  });

  it('falls back when a destructured object alias is mutated through its source', () => {
    const code = dedent`
      const source = { nested: { value: 1 } };
      const { nested } = source;
      source.nested.value = 2;

      const template = tag\`${'${nested.value}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['nested']);
  });

  it('falls back when a source is mutated through a local alias', () => {
    const code = dedent`
      const source = { width: 304 };
      const alias = source;
      alias.width = 400;
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['width']);
  });

  it('checks initializer hazards when the alias binding has no own changes', () => {
    const code = dedent`
      const source = { width: 304 };
      Object.assign(source, { width: 400 });
      const alias = source;
      alias.width;
    `;
    const expressionStart = code.lastIndexOf('alias.width');
    const analysis = analyzeProgram(parseOxc(code, filename));
    const resolutionContext = {
      bindingIndex: analysis.bindingIndex,
    };
    const sourceBinding = resolveBindingAt(
      resolutionContext,
      'source',
      code.indexOf('source;')
    );
    const aliasBinding = resolveBindingAt(
      resolutionContext,
      'alias',
      code.indexOf('alias.width')
    );

    expect(sourceBinding).toBeDefined();
    expect(aliasBinding).toBeDefined();
    expect(
      getRootMutationHazards(
        analysis.rootMutationHazardsByBinding,
        toMutationBindingKey(sourceBinding!)
      )
    ).not.toHaveLength(0);
    expect(
      getRootMutationHazards(
        analysis.rootMutationHazardsByBinding,
        toMutationBindingKey(aliasBinding!)
      )
    ).toHaveLength(0);

    expect(
      evaluateOxcStaticExpressionAt(code, filename, {
        end: expressionStart + 'alias.width'.length,
        start: expressionStart,
      })
    ).toBeUndefined();
  });

  it('falls back when a nested source is mutated through a scoped alias', () => {
    const code = dedent`
      function Component() {
        const source = { width: 304 };
        const alias = source;
        alias.width = 400;
        const { width } = source;
        const template = tag\`${'${width}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['width']);
  });

  it.each([
    ['a conditional expression', 'const alias = true ? source : {};'],
    ['a logical expression', 'const alias = true && source;'],
    ['a sequence expression', 'const alias = (0, source);'],
    ['an inline function call', 'const alias = (() => source)();'],
    [
      'a local function call',
      'function getSource() { return source; } const alias = getSource();',
    ],
    [
      'a hoisted local function call',
      'const alias = getSource(); function getSource() { return source; }',
    ],
    [
      'a class method call',
      'class GetSource { static value() { return source; } } const alias = GetSource.value();',
    ],
    [
      'an optional member expression',
      'const holder = { source }; const alias = holder?.source;',
    ],
  ])('falls back when a source is mutated through %s', (_kind, setup) => {
    const code = dedent`
      const source = { width: 304 };
      ${setup}
      alias.width = 400;
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['width']);
  });

  it('falls back when a mutated unknown call result can alias an imported source', () => {
    const code = dedent`
      import { getSource, source } from './tokens';

      const alias = getSource();
      alias.width = 400;
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['width']);
  });

  it('falls back for a direct imported expression after mutation', () => {
    const code = dedent`
      import { source } from './tokens';

      source.width = 400;
      const template = tag\`${'${source.width}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['source']);
  });

  it('falls back when an opaque imported call can mutate another export', () => {
    const code = dedent`
      import { mutate, source } from './tokens';

      mutate();
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['width']);
  });

  it('falls back when an imported destructuring source escapes to mutating code', () => {
    const code = dedent`
      import { theme } from './tokens';

      Object.assign(theme.size, { width: 400 });
      const { size: { width } } = theme;
      const template = tag\`${'${width}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['width']);
  });

  it.each([
    'Object.assign(source, { width: 400 });',
    'delete source.width;',
    'source.width += 96;',
    "const key = 'width'; source[key] = 400;",
  ])('falls back for an unmodeled source mutation: %s', (mutation) => {
    const code = dedent`
      const source = { width: 304 };
      ${mutation}
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['width']);
  });

  it('preserves a scalar snapshot across later unmodeled source mutations', () => {
    const code = dedent`
      const source = { width: 304 };
      const { width } = source;
      Object.assign(source, { width: 400 });
      const template = tag\`${'${width}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([{ name: '_exp', value: 304 }]);
    expect(result.staticValueCandidates).toEqual([]);
  });

  it('falls back when an object-valued default is mutated after destructuring', () => {
    const code = dedent`
      const fallback = { value: 1 };
      const { selected = fallback } = {};
      fallback.value = 2;
      const template = tag\`${'${selected.value}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['selected']);
  });

  it('falls back when a destructuring default aliases and mutates its source', () => {
    const code = dedent`
      import { source } from './tokens';

      const alias = source;
      const { selected = alias } = {};
      selected.width = 400;
      const { width } = source;
      const template = tag\`${'${width}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['width']);
  });

  it('falls back when a selected object is mutated through its source binding', () => {
    const code = dedent`
      const shared = { value: 1 };
      const source = { selected: shared };
      const { selected } = source;
      shared.value = 2;
      const template = tag\`${'${selected.value}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['selected']);
  });

  it('falls back when a computed key depends on a mutable binding', () => {
    const code = dedent`
      let key = 'first';
      key = 'second';
      const { [key]: selected } = { first: 1, second: 2 };
      const template = tag\`${'${selected}'}\`;
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.staticValues).toEqual([]);
    expect(result.staticValueCandidates).toEqual([]);
    expect(result.dependencyNames).toEqual(['selected']);
  });

  it.each(['let', 'var'])(
    'keeps mutable %s destructuring on the evaluator path',
    (declarationKind) => {
      const code = dedent`
        import { theme } from './tokens';

        ${declarationKind} { width } = theme;
        const template = tag\`${'${width}'}\`;
      `;

      const result = collectOxcTemplateDependencies(code, filename, true);

      expect(result.staticValues).toEqual([]);
      expect(result.staticValueCandidates).toEqual([]);
      expect(result.dependencyNames).toEqual(['width']);
    }
  );

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

  it('statically evaluates local destructuring dependencies', () => {
    const code = dedent`
      function fn() {
        const result = "result";
        const { variable } = { variable: result };
        const template = tag\`${'${variable}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain('const _exp = () => ("result");');
    expect(result.staticValues).toEqual([{ name: '_exp', value: 'result' }]);
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

  it('statically evaluates object members with processor-managed siblings', () => {
    const code = dedent`
      import { css } from "test-package";

      function Component() {
        const classes = {
          value: 0.2,
          cell: css\`
            opacity: 0;
          \`,
        };
        const template = tag\`${'${classes.value}'}\`;
      }
    `;

    const result = collectOxcTemplateDependencies(code, filename, true);

    expect(result.code).toContain('const _exp = () => (0.2);');
    expect(result.staticValues).toEqual(
      expect.arrayContaining([{ name: '_exp', value: 0.2 }])
    );
    expect(result.staticValueCandidates).toEqual([]);
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

  it('applies prior top-level object mutations to metadata without replacing the executable value', () => {
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

    expect(result.code).toContain('const _exp = () => (foo("font"));');
    expect(result.staticValues).toEqual([
      {
        name: '_exp',
        value: { fontSize: 12, fontWeight: 'bold' },
      },
    ]);
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
