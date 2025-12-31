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
});
