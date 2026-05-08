import { createRequire } from 'node:module';

import { SourceMapGenerator, type RawSourceMap } from 'source-map';

type RemappingFn = (
  input: RawSourceMap | RawSourceMap[],
  loader: (source: string, context: unknown) => RawSourceMap | null | undefined
) => RawSourceMap;

const remapping = createRequire(import.meta.url)(
  '@jridgewell/remapping'
) as RemappingFn;

const countLines = (code: string): number => code.split('\n').length;

const createLineSourceMap = (
  generatedCode: string,
  originalCode: string,
  filename: string
): RawSourceMap => {
  const generator = new SourceMapGenerator({
    file: filename,
  });
  const generatedLines = countLines(generatedCode);
  const originalLines = countLines(originalCode);

  for (let line = 1; line <= generatedLines; line += 1) {
    generator.addMapping({
      generated: {
        column: 0,
        line,
      },
      original: {
        column: 0,
        line: Math.min(line, originalLines),
      },
      source: filename,
    });
  }

  generator.setSourceContent(filename, originalCode);

  return generator.toJSON() as RawSourceMap;
};

export const createComposedRuntimeSourceMap = (
  generatedCode: string,
  originalCode: string,
  filename: string,
  inputSourceMap?: RawSourceMap
): RawSourceMap => {
  const runtimeMap = createLineSourceMap(generatedCode, originalCode, filename);
  if (!inputSourceMap) {
    return runtimeMap;
  }

  const composed = remapping([runtimeMap, inputSourceMap], () => null);
  return {
    ...composed,
    file: runtimeMap.file,
  } as RawSourceMap;
};
