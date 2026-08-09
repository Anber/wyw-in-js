/* eslint-env jest */
import { applyOxcReplacementLayers } from '../replacements';

describe('applyOxcReplacementLayers', () => {
  it('keeps the outer replacement regardless of layer order', () => {
    const outer = { start: 1, end: 5, value: 'outer' };
    const inner = { start: 2, end: 4, value: 'inner' };

    expect(applyOxcReplacementLayers('abcdef', [[inner], [outer]])).toBe(
      'aouterf'
    );
    expect(applyOxcReplacementLayers('abcdef', [[outer], [inner]])).toBe(
      'aouterf'
    );
  });

  it('uses the earlier layer for equal ranges', () => {
    expect(
      applyOxcReplacementLayers('abc', [
        [{ start: 0, end: 3, value: 'processor' }],
        [{ start: 0, end: 3, value: 'dangerous' }],
      ])
    ).toBe('processor');
  });

  it('preserves boundary insertions and drops interior insertions', () => {
    expect(
      applyOxcReplacementLayers('abcdef', [
        [{ start: 1, end: 5, value: 'X' }],
        [
          { start: 1, end: 1, text: '<' },
          { start: 3, end: 3, text: 'discarded' },
          { start: 5, end: 5, text: '>' },
        ],
      ])
    ).toBe('a<X>f');
  });

  it('rejects partial overlaps between layers', () => {
    expect(() =>
      applyOxcReplacementLayers('abcdef', [
        [{ start: 1, end: 4, value: 'left' }],
        [{ start: 3, end: 5, value: 'right' }],
      ])
    ).toThrow('Oxc replacement layers overlap without containment');
  });
});
