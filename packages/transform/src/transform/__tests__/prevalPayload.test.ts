/* eslint-env jest */

import { createPrevalPayload } from '../prevalPayload';

const filename = '/project/src/entry.tsx';

describe('createPrevalPayload', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('creates a static-only payload when eval is skipped', () => {
    const payload = createPrevalPayload({
      filename,
      strategy: 'static',
      staticDependencies: ['/project/src/tokens.ts'],
      staticValues: new Map([['_exp', 'red']]),
    });

    expect(payload.dependencies).toEqual(['/project/src/tokens.ts']);
    expect(payload.values).toEqual(new Map([['_exp', 'red']]));
    expect(payload.sources).toEqual(new Map([['_exp', 'static']]));
  });

  it.each(['test', 'staging', 'production'])(
    'uses evaluated values and dependencies exclusively for execute with NODE_ENV=%s',
    (nodeEnv) => {
      process.env.NODE_ENV = nodeEnv;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const payload = createPrevalPayload({
        evalDependencies: ['/project/src/eval-only.ts'],
        evalValues: new Map([['_exp', 'eval-red']]),
        filename,
        staticDependencies: ['/project/src/static-only.ts'],
        staticValues: new Map([
          ['_exp', 'static-red'],
          ['_exp2', 'static-blue'],
        ]),
        strategy: 'execute',
      });

      expect(warn).not.toHaveBeenCalled();
      expect(payload.dependencies).toEqual(['/project/src/eval-only.ts']);
      expect(payload.values).toEqual(new Map([['_exp', 'eval-red']]));
      expect(payload.sources).toEqual(new Map([['_exp', 'eval']]));
    }
  );

  it('uses static values and dependencies exclusively for static', () => {
    const payload = createPrevalPayload({
      evalDependencies: ['/project/src/eval-only.ts'],
      evalValues: new Map([
        ['_exp', 'eval-red'],
        ['_exp2', 'eval-blue'],
      ]),
      filename,
      staticDependencies: ['/project/src/static-only.ts'],
      staticValues: new Map([['_exp2', 'static-blue']]),
      strategy: 'static',
    });

    expect(payload.dependencies).toEqual(['/project/src/static-only.ts']);
    expect(payload.values).toEqual(new Map([['_exp2', 'static-blue']]));
    expect(payload.sources).toEqual(new Map([['_exp2', 'static']]));
  });

  it('combines hybrid values and records static precedence on overlap', () => {
    const payload = createPrevalPayload({
      evalDependencies: ['/project/src/eval-only.ts'],
      evalValues: new Map([
        ['_exp', 'eval-red'],
        ['_exp2', 'eval-blue'],
      ]),
      filename,
      staticDependencies: [
        '/project/src/static-only.ts',
        '/project/src/eval-only.ts',
      ],
      staticValues: new Map([['_exp2', 'eval-blue']]),
      strategy: 'hybrid',
    });

    expect(payload.dependencies).toEqual([
      '/project/src/eval-only.ts',
      '/project/src/static-only.ts',
    ]);
    expect(payload.values).toEqual(
      new Map([
        ['_exp', 'eval-red'],
        ['_exp2', 'eval-blue'],
      ])
    );
    expect(payload.sources).toEqual(
      new Map([
        ['_exp', 'eval'],
        ['_exp2', 'static'],
      ])
    );
  });

  it('throws on hybrid disagreement outside production', () => {
    process.env.NODE_ENV = 'test';

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([['_exp', 'eval-red']]),
        filename,
        staticValues: new Map([['_exp', 'static-red']]),
        strategy: 'hybrid',
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('warns and keeps static precedence on hybrid disagreement in production', () => {
    process.env.NODE_ENV = 'production';
    const warnings: string[] = [];
    const payload = createPrevalPayload({
      emitWarning: (message) => warnings.push(message),
      evalValues: new Map([['_exp', 'eval-red']]),
      filename,
      staticValues: new Map([['_exp', 'static-red']]),
      strategy: 'hybrid',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('PrevalPayload disagreement');
    expect(payload.values).toEqual(new Map([['_exp', 'static-red']]));
    expect(payload.sources).toEqual(new Map([['_exp', 'static']]));
  });

  it('deduplicates selected dependencies in hybrid mode', () => {
    const payload = createPrevalPayload({
      evalDependencies: ['/project/src/shared.ts'],
      filename,
      staticDependencies: ['/project/src/shared.ts'],
      strategy: 'hybrid',
    });

    expect(payload.dependencies).toEqual(['/project/src/shared.ts']);
  });
});
