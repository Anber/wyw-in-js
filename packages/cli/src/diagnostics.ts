import type { WYWTransformDiagnostic } from '@wyw-in-js/transform';

const formatLocation = (diagnostic: WYWTransformDiagnostic) => {
  if (!diagnostic.start) {
    return diagnostic.filename;
  }

  return `${diagnostic.filename}:${diagnostic.start.line}:${
    diagnostic.start.column + 1
  }`;
};

export const formatTransformDiagnostic = (diagnostic: WYWTransformDiagnostic) =>
  [
    `[wyw-in-js] ${diagnostic.severity} [${diagnostic.category}] ${diagnostic.message}`,
    `  at ${formatLocation(diagnostic)} (${diagnostic.displayName})`,
  ].join('\n');

export const reportTransformDiagnostics = (
  diagnostics: WYWTransformDiagnostic[]
) => {
  diagnostics.forEach((diagnostic) => {
    // eslint-disable-next-line no-console
    console.warn(formatTransformDiagnostic(diagnostic));
  });
};
