/**
 * Insert an import statement in a safe position:
 * - after the last existing import declaration,
 * - otherwise after the directive prologue (e.g. 'use client'),
 * - otherwise at the top of the file.
 */
export function insertImportStatement(code: string, importStatement: string) {
  if (code.includes(importStatement)) {
    return code;
  }

  const importRegex =
    /^\s*(?:import\s+[^;]+?\s+from\s+["'][^"']+["'];|import\s*["'][^"']+["'];)/gm;
  const importMatches = [...code.matchAll(importRegex)];
  if (importMatches.length > 0) {
    const lastImport = importMatches[importMatches.length - 1];
    const insertPosition = lastImport.index! + lastImport[0].length;
    return `${code.slice(0, insertPosition)}\n${importStatement}${code.slice(
      insertPosition
    )}`;
  }

  const directiveRegex = /^(?:(?:\s*["']use \w+["'];?\s*\n?)+)/;
  const directiveMatch = code.match(directiveRegex);
  if (directiveMatch) {
    const endOfDirectives = directiveMatch[0].length;
    const needsNewline = !code.slice(0, endOfDirectives).endsWith('\n');
    const separator = needsNewline ? '\n' : '';
    return `${code.slice(
      0,
      endOfDirectives
    )}${separator}${importStatement}\n${code.slice(endOfDirectives)}`;
  }

  return `${importStatement}\n${code}`;
}
