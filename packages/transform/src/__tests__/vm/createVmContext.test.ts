import { createVmContext } from '../../vm/createVmContext';

describe('createVmContext', () => {
  it.each([{ happyDOM: true }, { happyDOM: false }])(
    'should create a VM context with "happy-dom" (%p)',
    (features) => {
      const vmContext = createVmContext('filename', features, {});

      expect(vmContext).toMatchObject({
        context: expect.any(Object),
        teardown: expect.any(Function),
      });

      expect(vmContext.context).toMatchObject({
        __filename: 'filename',

        self: vmContext.context,
        top: vmContext.context,

        setInterval: expect.any(Function),
        setTimeout: expect.any(Function),
      });
    }
  );
});
