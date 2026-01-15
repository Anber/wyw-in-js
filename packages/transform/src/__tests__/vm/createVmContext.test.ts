import { createVmContext } from '../../vm/createVmContext';

describe('createVmContext', () => {
  it.each([{ happyDOM: true }, { happyDOM: false }])(
    'should create a VM context with "happy-dom" (%p)',
    (features) => {
      const vmContext = createVmContext('filename', features, {});

      expect(vmContext).toBeTruthy();
      expect(typeof vmContext).toBe('object');
      expect(vmContext.context).toBeTruthy();
      expect(typeof vmContext.teardown).toBe('function');
      expect(() => vmContext.teardown()).not.toThrow();
    }
  );

  it('falls back when happy-dom cannot be required (ERR_REQUIRE_ESM)', () => {
    const hookKey = '__wyw_requireHappyDom';
    const originalHook = (globalThis as any)[hookKey] as unknown;

    (globalThis as any)[hookKey] = () => {
      const error = new Error(
        'require() of ES Module happy-dom is not supported'
      ) as Error & { code?: string };
      error.code = 'ERR_REQUIRE_ESM';
      throw error;
    };

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const vmContext = createVmContext('filename', { happyDOM: true }, {});

      expect(vmContext).toBeTruthy();
      expect(typeof vmContext.teardown).toBe('function');
      expect(() => vmContext.teardown()).not.toThrow();

      const warning = warnSpy.mock.calls.flat().join('\n');
      expect(warning).toContain('happyDOM');
      expect(warning).toContain('happy-dom');
      expect(warning).toContain('features: { happyDOM: false }');
    } finally {
      if (typeof originalHook === 'undefined') {
        delete (globalThis as any)[hookKey];
      } else {
        (globalThis as any)[hookKey] = originalHook;
      }
      warnSpy.mockRestore();
    }
  });
});
