import { BaseProcessor } from '../BaseProcessor';
import type { ProcessorStaticContext, ProcessorStaticValue } from '../static';

describe('processor static contract', () => {
  it('exports optional static value shapes without changing BaseProcessor runtime', () => {
    const serializable: ProcessorStaticValue = {
      kind: 'serializable',
      value: { color: 'red' },
    };
    const className: ProcessorStaticValue = {
      className: 'abc123',
      kind: 'class-name',
    };
    const unresolved: ProcessorStaticValue = {
      kind: 'unresolved',
      reason: 'dynamic-value',
    };
    const context = null as unknown as ProcessorStaticContext;

    expect(serializable.kind).toBe('serializable');
    expect(className.kind).toBe('class-name');
    expect(unresolved.reason).toBe('dynamic-value');
    expect(context).toBeNull();
    expect(BaseProcessor.SKIP.description).toBe('skip');
  });
});
