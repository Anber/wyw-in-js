import {
  deserializeValue,
  serializePreval,
  serializeValue,
} from '../eval/serialize';

describe('eval IPC serialization', () => {
  it('round-trips nested plain data without JSON coercion', () => {
    const boom = new TypeError('boom');
    boom.stack = 'TypeError: boom';

    const input = {
      nothing: null,
      enabled: true,
      label: 'demo',
      count: 42,
      nested: {
        missing: undefined,
        bigint: 17n,
        values: [undefined, Number.NaN, Infinity, -Infinity, { ok: 'yes' }],
        failure: boom,
      },
    };

    const roundTripped = deserializeValue(
      serializeValue(input, { allowFunctions: true })
    ) as {
      nothing: null;
      enabled: boolean;
      label: string;
      count: number;
      nested: {
        missing?: undefined;
        bigint: bigint;
        values: [undefined, number, number, number, { ok: string }];
        failure: Error;
      };
    };

    expect(roundTripped.nothing).toBeNull();
    expect(roundTripped.enabled).toBe(true);
    expect(roundTripped.label).toBe('demo');
    expect(roundTripped.count).toBe(42);
    expect(roundTripped.nested.bigint).toBe(17n);
    expect(roundTripped.nested.values[0]).toBeUndefined();
    expect(Number.isNaN(roundTripped.nested.values[1])).toBe(true);
    expect(roundTripped.nested.values[2]).toBe(Infinity);
    expect(roundTripped.nested.values[3]).toBe(-Infinity);
    expect(roundTripped.nested.values[4]).toEqual({ ok: 'yes' });
    expect(
      Object.prototype.hasOwnProperty.call(roundTripped.nested, 'missing')
    ).toBe(true);
    expect(roundTripped.nested.failure).toBeInstanceOf(Error);
    expect(roundTripped.nested.failure).toMatchObject({
      message: 'boom',
      name: 'TypeError',
      stack: 'TypeError: boom',
    });
  });

  it('preserves functions as opaque callable sentinels', () => {
    const input = {
      topLevel: () => 'value',
      nested: {
        list: [() => 1],
        marker: Symbol.for('react.forward_ref'),
      },
    };

    const roundTripped = deserializeValue(
      serializeValue(input, { allowFunctions: true, allowSymbols: true })
    ) as {
      topLevel: () => unknown;
      nested: {
        list: Array<() => unknown>;
        marker: symbol;
      };
    };

    expect(typeof roundTripped.topLevel).toBe('function');
    expect(roundTripped.topLevel()).toBeUndefined();
    expect(typeof roundTripped.nested.list[0]).toBe('function');
    expect(roundTripped.nested.list[0]()).toBeUndefined();
    expect(typeof roundTripped.nested.marker).toBe('symbol');
    expect(roundTripped.nested.marker).toBe(Symbol.for('react.forward_ref'));
  });

  it.each([
    {
      label: 'Date',
      value: { value: { nested: [new Date(0)] } },
      path: '__wywPreval.value.nested[0]',
      detail: 'unsupported non-plain object (Date)',
    },
    {
      label: 'Map',
      value: { value: new Map([['a', 1]]) },
      path: '__wywPreval.value',
      detail: 'unsupported non-plain object (Map)',
    },
    {
      label: 'Set',
      value: { value: new Set([1]) },
      path: '__wywPreval.value',
      detail: 'unsupported non-plain object (Set)',
    },
    {
      label: 'class instance',
      value: {
        value: new (class Box {
          public readonly current = 1;
        })(),
      },
      path: '__wywPreval.value',
      detail: 'unsupported non-plain object (Box)',
    },
  ])('reports path-aware failures for $label values', ({ value, path, detail }) => {
    expect(() => serializePreval(value)).toThrow('[wyw-in-js] __wywPreval');
    expect(() => serializePreval(value)).toThrow(path);
    expect(() => serializePreval(value)).toThrow(detail);
  });
});
