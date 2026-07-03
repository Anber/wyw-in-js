/* eslint-env jest */

import { createPrevalPayload } from '../prevalPayload';

const filename = '/project/src/entry.tsx';

describe('createPrevalPayload', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('creates a static-only payload when eval is skipped', () => {
    const payload = createPrevalPayload({
      filename,
      staticDependencies: ['/project/src/tokens.ts'],
      staticValues: new Map([['_exp', 'red']]),
    });

    expect(payload.dependencies).toEqual(['/project/src/tokens.ts']);
    expect(payload.values).toEqual(new Map([['_exp', 'red']]));
    expect(payload.sources).toEqual(new Map([['_exp', 'static']]));
  });

  it('overlays static values after eval values and records per-name sources', () => {
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

  it('throws on static/eval disagreement outside production', () => {
    process.env.NODE_ENV = 'test';

    expect(() =>
      createPrevalPayload({
        evalValues: new Map([['_exp', 'eval-red']]),
        filename,
        staticValues: new Map([['_exp', 'static-red']]),
      })
    ).toThrow('[wyw-in-js] PrevalPayload disagreement');
  });

  it('warns and keeps static precedence on disagreement in production', () => {
    process.env.NODE_ENV = 'production';
    const warnings: string[] = [];
    const payload = createPrevalPayload({
      emitWarning: (message) => warnings.push(message),
      evalValues: new Map([['_exp', 'eval-red']]),
      filename,
      staticValues: new Map([['_exp', 'static-red']]),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('PrevalPayload disagreement');
    expect(payload.values).toEqual(new Map([['_exp', 'static-red']]));
    expect(payload.sources).toEqual(new Map([['_exp', 'static']]));
  });
});
