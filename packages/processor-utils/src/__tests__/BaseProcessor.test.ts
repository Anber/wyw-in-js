import { BaseProcessor } from '../BaseProcessor';

describe('BaseProcessor', () => {
  it('accepts eval metadata without reading unrelated enumerable fields', () => {
    const readRuntimeState = jest.fn(() => {
      throw new Error('runtime state is unavailable');
    });
    const value = {
      __wyw_meta: {
        className: 'base',
        extends: null,
      },
    };

    Object.defineProperty(value, 'runtimeState', {
      enumerable: true,
      get: readRuntimeState,
    });

    expect(BaseProcessor.prototype.isValidValue(value)).toBe(true);
    expect(readRuntimeState).not.toHaveBeenCalled();
  });
});
