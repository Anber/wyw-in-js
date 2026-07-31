import { analyzeProgram, createSpanLookup, parseOxc } from '../scopeAnalysis';

const filename = '/scope-analysis-cache.ts';

const span = (code: string, source: string, from = 0) => {
  const start = code.indexOf(source, from);
  if (start < 0) {
    throw new Error(`Missing source: ${source}`);
  }

  return { end: start + source.length, start };
};

const hazardSignature = (
  code: string,
  analysis: ReturnType<typeof analyzeProgram>
): string[] =>
  [...analysis.rootMutationHazardsByBinding]
    .flatMap(([binding, timeline]) =>
      timeline.byStart.map(
        (node) => `${binding}:${code.slice(node.start, node.end)}`
      )
    )
    .sort();

describe('program scope facts cache', () => {
  it('reuses stable facts without sharing request projections', () => {
    const code = [
      'const alpha = 1;',
      'const beta = 2;',
      'const first = `first:${alpha}`;',
      'const second = `second:${beta}`;',
    ].join('\n');
    const program = parseOxc(code, filename);
    const firstTemplate = span(code, '`first:${alpha}`');
    const secondTemplate = span(code, '`second:${beta}`');
    const alpha = span(code, 'alpha', firstTemplate.start);
    const beta = span(code, 'beta', secondTemplate.start);
    const first = analyzeProgram(program, {
      collectTargetExpressions: true,
      collectTemplateLiterals: true,
      expressionSpanLookup: createSpanLookup([alpha]),
      templateSpanLookup: createSpanLookup([firstTemplate]),
    });
    const firstAgain = analyzeProgram(program, {
      collectTargetExpressions: true,
      collectTemplateLiterals: true,
      expressionSpanLookup: createSpanLookup([alpha]),
      templateSpanLookup: createSpanLookup([firstTemplate]),
    });

    const second = analyzeProgram(program, {
      collectTargetExpressions: true,
      collectTemplateLiterals: true,
      expressionSpanLookup: createSpanLookup([beta]),
      templateSpanLookup: createSpanLookup([secondTemplate]),
    });

    expect(firstAgain).toBe(first);
    expect(second.bindingIndex).toBe(first.bindingIndex);
    expect(second.rootMutationsByBinding).toBe(first.rootMutationsByBinding);
    expect(second.rootMutationHazardsByBinding).toBe(
      first.rootMutationHazardsByBinding
    );
    expect(second.usedNames).toBe(first.usedNames);
    expect(Object.isFrozen(first.bindingIndex)).toBe(true);
    expect(Object.isFrozen(first.usedNames)).toBe(true);
    expect(Reflect.set(first.bindingIndex, 'bindingsByName', new Map())).toBe(
      false
    );
    expect(second.usedNames.has('beta')).toBe(true);
    expect(() => first.usedNames.delete('beta')).toThrow(
      'Cached program analysis is immutable'
    );
    expect(
      first.targetExpressions.map((node) => code.slice(node.start, node.end))
    ).toEqual(['alpha']);
    expect(
      second.targetExpressions.map((node) => code.slice(node.start, node.end))
    ).toEqual(['beta']);
    expect(
      first.templateLiterals.map((node) => code.slice(node.start, node.end))
    ).toEqual(['`first:${alpha}`']);
    expect(
      second.templateLiterals.map((node) => code.slice(node.start, node.end))
    ).toEqual(['`second:${beta}`']);
  });

  it('does not spend LRU entries on semantically unused lookups', () => {
    const code = 'const values = [one, two, three];';
    const program = parseOxc(code, filename);
    const spans = ['one', 'two', 'three'].map((name) => span(code, name));
    const baseline = analyzeProgram(program);
    const equivalentWithoutCollection = analyzeProgram(program, {
      expressionSpanLookup: createSpanLookup([spans[0]!]),
      mutationHazardIgnoreLookup: new Set(),
      templateSpanLookup: createSpanLookup([spans[1]!]),
    });
    const equivalentWithEmptyTargetLookup = analyzeProgram(program, {
      collectTargetExpressions: true,
      expressionSpanLookup: new Set(),
    });

    spans.forEach((expressionSpan) => {
      analyzeProgram(program, {
        collectTargetExpressions: true,
        expressionSpanLookup: createSpanLookup([expressionSpan]),
      });
    });

    expect(equivalentWithoutCollection).toBe(baseline);
    expect(equivalentWithEmptyTargetLookup).toBe(baseline);
    expect(analyzeProgram(program)).toBe(baseline);

    const templateCode = 'const view = `value:${one}`;';
    const templateProgram = parseOxc(templateCode, filename);
    const allTemplates = analyzeProgram(templateProgram, {
      collectTemplateLiterals: true,
    });
    const emptyTemplateLookup = analyzeProgram(templateProgram, {
      collectTemplateLiterals: true,
      templateSpanLookup: new Set(),
    });

    expect(emptyTemplateLookup).not.toBe(allTemplates);
    expect(allTemplates.templateLiterals).toHaveLength(1);
    expect(emptyTemplateLookup.templateLiterals).toHaveLength(0);
  });

  it('keys ignored hazard variants by normalized request contents', () => {
    const code = [
      "import { source } from './tokens';",
      'const value = tag`${source}`;',
    ].join('\n');
    const program = parseOxc(code, filename);
    const taggedTemplate = span(code, 'tag`${source}`');
    const baseline = analyzeProgram(program);
    const ignored = analyzeProgram(program, {
      mutationHazardIgnoreLookup: createSpanLookup([taggedTemplate]),
    });
    const ignoredAgain = analyzeProgram(program, {
      mutationHazardIgnoreLookup: createSpanLookup([taggedTemplate]),
    });
    const baselineAgain = analyzeProgram(program);

    expect(ignored.bindingIndex).toBe(baseline.bindingIndex);
    expect(ignored.rootMutationsByBinding).toBe(
      baseline.rootMutationsByBinding
    );
    expect(ignored.rootMutationHazardsByBinding).not.toBe(
      baseline.rootMutationHazardsByBinding
    );
    expect(ignoredAgain).toBe(ignored);
    expect(hazardSignature(code, ignoredAgain)).toEqual(
      hazardSignature(code, ignored)
    );
    expect(hazardSignature(code, ignored)).not.toEqual(
      hazardSignature(code, baseline)
    );
    expect(baselineAgain.rootMutationHazardsByBinding).toBe(
      baseline.rootMutationHazardsByBinding
    );
  });

  it('bounds request variants without rebuilding stable scope facts', () => {
    const code = 'const values = [one, two, three, four, five];';
    const program = parseOxc(code, filename);
    const spans = ['one', 'two', 'three', 'four', 'five'].map((name) =>
      span(code, name)
    );
    const analyze = (index: number) =>
      analyzeProgram(program, {
        collectTargetExpressions: true,
        expressionSpanLookup: createSpanLookup([spans[index]!]),
      });
    const first = analyze(0);

    const variants = spans.slice(1).map((_item, index) => analyze(index + 1));
    const firstAfterEviction = analyze(0);

    expect(firstAfterEviction).not.toBe(first);
    expect(firstAfterEviction.bindingIndex).toBe(first.bindingIndex);
    expect(firstAfterEviction.rootMutationsByBinding).toBe(
      first.rootMutationsByBinding
    );
    expect(
      variants.map((analysis) =>
        code.slice(
          analysis.targetExpressions[0]!.start,
          analysis.targetExpressions[0]!.end
        )
      )
    ).toEqual(['two', 'three', 'four', 'five']);
  });
});
