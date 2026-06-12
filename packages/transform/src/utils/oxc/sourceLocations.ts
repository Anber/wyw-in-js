import type { SourceLocation } from '@wyw-in-js/shared';

export type OxcLocationLookup = (offset: number) => SourceLocation['start'];

export const createOxcLocationLookup = (code: string): OxcLocationLookup => {
  const lineStarts = [0];
  for (let idx = 0; idx < code.length; idx += 1) {
    if (code[idx] === '\n') {
      lineStarts.push(idx + 1);
    }
  }

  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const next = lineStarts[mid + 1] ?? Infinity;
      if (lineStarts[mid] <= offset && offset < next) {
        return {
          column: offset - lineStarts[mid],
          line: mid + 1,
        };
      }

      if (offset < lineStarts[mid]) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    const lastLine = lineStarts.length - 1;
    return {
      column: Math.max(0, offset - lineStarts[lastLine]),
      line: lastLine + 1,
    };
  };
};

export const createOxcSourceLocation = (
  start: number,
  end: number,
  loc: OxcLocationLookup,
  filename?: string | null,
  identifierName?: string | null
): SourceLocation => ({
  end: loc(end),
  filename: filename ?? undefined,
  identifierName,
  start: loc(start),
});

export const buildOxcCodeFrameError = (
  code: string,
  location: SourceLocation,
  message: string
): Error => {
  const lines = code.split('\n');
  const startLine = location.start.line;
  const endLine = location.end.line;
  const frameStart = Math.max(1, startLine - 2);
  const frameEnd = Math.min(lines.length, endLine + 2);
  const lineNoWidth = String(frameEnd).length;
  const frame: string[] = [];

  for (let lineNo = frameStart; lineNo <= frameEnd; lineNo += 1) {
    const marker = lineNo === startLine ? '>' : ' ';
    const line = lines[lineNo - 1] ?? '';
    frame.push(
      line.length > 0
        ? `${marker} ${String(lineNo).padStart(lineNoWidth)} | ${line}`
        : `${marker} ${String(lineNo).padStart(lineNoWidth)} |`
    );

    if (lineNo === startLine) {
      const pointerLength =
        startLine === endLine
          ? Math.max(1, location.end.column - location.start.column)
          : 1;
      frame.push(
        `  ${' '.repeat(lineNoWidth)} | ${' '.repeat(
          location.start.column
        )}${'^'.repeat(pointerLength)}`
      );
    }
  }

  const prefix = location.filename ? `${location.filename}: ` : '';
  return new Error(`${prefix}${message}\n${frame.join('\n')}`);
};
