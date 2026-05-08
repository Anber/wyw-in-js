/* eslint-env jest */
import { loadWywOptions } from '../transform/helpers/loadWywOptions';

describe('loadWywOptions eval options', () => {
  it('defaults to hybrid strategy with nodejs runtime and strict errors', () => {
    const options = loadWywOptions({ configFile: false });

    expect(options.eval).toMatchObject({
      errors: 'strict',
      require: 'warn-and-run',
      resolver: 'bundler',
      runtime: 'nodejs',
      strategy: 'hybrid',
    });
    expect(options.features).not.toHaveProperty('staticImportValues');
    expect(options).not.toHaveProperty('evaluate');
  });

  it('keeps strategy separate from error policy', () => {
    const options = loadWywOptions({
      configFile: false,
      eval: {
        errors: 'loose',
        runtime: 'nodejs',
        strategy: 'hybrid',
      },
    });

    expect(options.eval).toMatchObject({
      errors: 'loose',
      runtime: 'nodejs',
      strategy: 'hybrid',
    });
  });
});
