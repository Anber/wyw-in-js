import { analyzeProgram, parseOxc, resolveBindingAt } from '../scopeAnalysis';

const filename = '/binding-resolution.ts';

describe('binding resolution cache', () => {
  it('preserves repeated positive and negative resolutions', () => {
    const code = 'const source = 1; source; missing;';
    const analysis = analyzeProgram(parseOxc(code, filename));
    const sourceStart = code.indexOf('source;');
    const missingStart = code.indexOf('missing;');
    const ctx = { bindingIndex: analysis.bindingIndex };

    const source = resolveBindingAt(ctx, 'source', sourceStart);
    expect(source?.name).toBe('source');
    expect(resolveBindingAt(ctx, 'source', sourceStart)).toBe(source);

    expect(resolveBindingAt(ctx, 'missing', missingStart)).toBeUndefined();
    expect(resolveBindingAt(ctx, 'missing', missingStart)).toBeUndefined();
  });

  it('does not let a synthetic same-offset lookup poison another name', () => {
    const code = `
      const first = 1;
      const second = 2;
      {
        const first = 3;
        const second = 4;
        first + second;
      }
    `;
    const analysis = analyzeProgram(parseOxc(code, filename));
    const referenceStart = code.lastIndexOf('first + second');
    const ctx = { bindingIndex: analysis.bindingIndex };

    const first = resolveBindingAt(ctx, 'first', referenceStart);
    const second = resolveBindingAt(ctx, 'second', referenceStart);

    expect(first?.name).toBe('first');
    expect(second?.name).toBe('second');
    expect(resolveBindingAt(ctx, 'first', referenceStart)).toBe(first);
  });

  it('does not let a negative same-offset lookup poison a binding', () => {
    const code = `
      { const hidden = 1; }
      { const hidden = 2; }
      const visible = 3;
      { const visible = 4; }
      visible;
    `;
    const analysis = analyzeProgram(parseOxc(code, filename));
    const referenceStart = code.lastIndexOf('visible;');
    const ctx = { bindingIndex: analysis.bindingIndex };

    expect(resolveBindingAt(ctx, 'hidden', referenceStart)).toBeUndefined();
    expect(resolveBindingAt(ctx, 'visible', referenceStart)?.name).toBe(
      'visible'
    );
    expect(resolveBindingAt(ctx, 'hidden', referenceStart)).toBeUndefined();
  });
});
