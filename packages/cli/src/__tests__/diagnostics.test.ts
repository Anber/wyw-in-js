import type { WYWTransformDiagnostic } from '@wyw-in-js/transform';

import {
  formatTransformDiagnostic,
  reportTransformDiagnostics,
} from '../diagnostics';

describe('CLI diagnostics', () => {
  const diagnostic: WYWTransformDiagnostic = {
    category: 'dx-style/raw-color',
    className: 'button_abcd',
    displayName: 'button',
    end: { column: 20, line: 3 },
    filename: '/repo/src/button.tsx',
    message: 'Use a design token instead of a raw color.',
    severity: 'warning',
    start: { column: 10, line: 3 },
  };

  it('formats source-linked diagnostics for terminal output', () => {
    expect(formatTransformDiagnostic(diagnostic)).toContain(
      '[wyw-in-js] warning [dx-style/raw-color] Use a design token instead of a raw color.'
    );
    expect(formatTransformDiagnostic(diagnostic)).toContain(
      '/repo/src/button.tsx:3:11'
    );
    expect(formatTransformDiagnostic(diagnostic)).toContain('(button)');
  });

  it('reports each diagnostic via console.warn', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    reportTransformDiagnostics([diagnostic]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dx-style/raw-color')
    );

    warnSpy.mockRestore();
  });
});
