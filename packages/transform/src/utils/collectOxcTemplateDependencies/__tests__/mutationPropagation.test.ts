/* eslint-env jest */

import type { MutationTimeline, ProgramAnalysis } from '../types';
import {
  analyzeProgram,
  getRootMutationHazards,
  parseOxc,
  unknownAliasMutationBinding,
} from '../scopeAnalysis';

const filename = '/mutation-propagation.ts';

const analyze = (code: string): ProgramAnalysis =>
  analyzeProgram(parseOxc(code, filename));

const timeline = (
  analysis: ProgramAnalysis,
  binding: string
): MutationTimeline =>
  analysis.rootMutationHazardsByBinding.get(binding) ?? {
    byEnd: [],
    byStart: [],
  };

const labels = (
  code: string,
  analysis: ProgramAnalysis,
  binding: string
): string[] =>
  getRootMutationHazards(analysis.rootMutationHazardsByBinding, binding).map(
    (node) => code.slice(node.start, node.end)
  );

describe('indexed mutation propagation', () => {
  it('promotes a late weak hazard to sibling-capable and wakes its import group', () => {
    const code = [
      'import { source, sibling } from "./tokens";',
      'let alias = source;',
      'if (flag) { alias.value = source; }',
    ].join('\n');
    const analysis = analyze(code);

    expect(labels(code, analysis, 'source')).toEqual(['alias.value = source']);
    expect(labels(code, analysis, 'sibling')).toEqual(['alias.value = source']);
    expect(labels(code, analysis, unknownAliasMutationBinding)).toEqual([
      'alias.value = source',
    ]);
  });

  it('does not broadcast an ordinary weak hazard to import siblings', () => {
    const code = [
      'import { source, sibling } from "./tokens";',
      'const sink = {};',
      'sink.value = source;',
    ].join('\n');
    const analysis = analyze(code);

    expect(labels(code, analysis, 'source')).toEqual(['sink.value = source']);
    expect(labels(code, analysis, 'sibling')).toEqual([]);
    expect(labels(code, analysis, unknownAliasMutationBinding)).toEqual([]);
  });

  it('keeps a modeled mutation seed out of hazards until it propagates', () => {
    const code = ['const source = {};', 'source.x = 1;'].join('\n');
    const analysis = analyze(code);
    const mutations = analysis.rootMutationsByBinding.get('source');

    expect(
      mutations?.byStart.map((node) => code.slice(node.start, node.end))
    ).toEqual(['source.x = 1']);
    expect(labels(code, analysis, 'source')).toEqual([]);
  });

  it('carries a strong escape through an alias chain to an import sibling', () => {
    const code = [
      'import { source, sibling } from "./tokens";',
      'const first = source;',
      'const second = first;',
      'function escape(_) {}',
      'escape(second);',
    ].join('\n');
    const analysis = analyze(code);

    expect(labels(code, analysis, 'source')).toEqual(['escape(second)']);
    expect(labels(code, analysis, 'sibling')).toEqual(['escape(second)']);
    expect(labels(code, analysis, unknownAliasMutationBinding)).toEqual([
      'escape(second)',
    ]);
  });

  it('deduplicates one strong node once per import group', () => {
    const code = [
      'import { first, second } from "./tokens";',
      'function touch() {}',
      'touch(first, second);',
    ].join('\n');
    const analysis = analyze(code);

    ['first', 'second', unknownAliasMutationBinding].forEach((binding) => {
      const nodes = getRootMutationHazards(
        analysis.rootMutationHazardsByBinding,
        binding
      );
      expect(nodes.map((node) => code.slice(node.start, node.end))).toEqual([
        'touch(first, second)',
      ]);
      expect(new Set(nodes).size).toBe(1);
    });
  });

  it('broadcasts through every import group that shares a local key', () => {
    const code = [
      'import { a, x } from "m1";',
      'import { b as a, y } from "m2";',
      'y.z = 1;',
    ].join('\n');
    const analysis = analyze(code);

    expect(labels(code, analysis, 'x')).toEqual(['y.z = 1']);
    expect(labels(code, analysis, unknownAliasMutationBinding)).toEqual([
      'y.z = 1',
    ]);
  });

  it('publishes imported strong facts weakly to UNKNOWN without re-entry', () => {
    const code = [
      'import { imported } from "./tokens";',
      'const sentinel = [];',
      'for (({}).slot of sentinel) {}',
      'function touch() {}',
      'touch(imported);',
    ].join('\n');
    const analysis = analyze(code);

    expect(labels(code, analysis, unknownAliasMutationBinding)).toEqual([
      'touch(imported)',
    ]);
    expect(labels(code, analysis, 'sentinel')).toEqual([]);
  });

  it('converges through a deep reverse chain with a cycle', () => {
    const depth = 256;
    const statements = ['const root = {};', 'let alias0 = root;'];
    for (let index = 1; index < depth; index += 1) {
      statements.push(`let alias${index} = alias${index - 1};`);
    }
    statements.push(`alias0 = alias${depth - 1};`);
    statements.push(`alias${depth - 1}.value = 1;`);
    const code = statements.join('\n');
    const analysis = analyze(code);
    const finalMutation = `alias${depth - 1}.value = 1`;
    const rootLabels = labels(code, analysis, 'root');

    expect(rootLabels.filter((label) => label === finalMutation)).toEqual([
      finalMutation,
    ]);
  });

  it('preserves each alias declaredAt fence', () => {
    const code = [
      'const source = {};',
      'alias.before = 1;',
      'const alias = source;',
      'alias.after = 2;',
    ].join('\n');
    const analysis = analyze(code);

    expect(labels(code, analysis, 'source')).toEqual(['alias.after = 2']);
  });

  it('processes both directions when one key occupies both sides of a multi-key link', () => {
    const code = [
      'let left = {}, shared = {}, right = {};',
      '[left, shared] = [shared, right];',
      'function touch() {}',
      'touch(shared);',
    ].join('\n');
    const analysis = analyze(code);

    ['left', 'shared', 'right'].forEach((binding) => {
      expect(
        labels(code, analysis, binding).filter(
          (label) => label === 'touch(shared)'
        )
      ).toEqual(['touch(shared)']);
    });
  });

  it('keeps dormant function links closed but opens call, new, and tag links', () => {
    const code = [
      'const source = {};',
      'function captures() { return source; }',
      'const dormant = captures;',
      'dormant.meta = 1;',
      'captures();',
      'new captures();',
      'captures`x`;',
    ].join('\n');
    const analysis = analyze(code);

    expect(labels(code, analysis, 'source')).toEqual([
      'captures()',
      'new captures()',
      'captures`x`',
    ]);
  });

  it('preserves shallow-copy directionality in both rest-link directions', () => {
    const code = [
      'const source = { nested: {} };',
      'const { ...rest } = source;',
      'rest.shallow = {};',
      'rest.nested.value = 1;',
      'source.shallow = {};',
      'source.nested.value = 2;',
    ].join('\n');
    const analysis = analyze(code);
    const nested = ['rest.nested.value = 1', 'source.nested.value = 2'];

    expect(labels(code, analysis, 'source')).toEqual(nested);
    expect(labels(code, analysis, 'rest')).toEqual(nested);
  });

  it('adds unproven UNKNOWN only while propagating target changes backward', () => {
    const code = [
      'const { ...rest } = registry.value;',
      'registry.shallow = 1;',
      'rest.nested.value = 2;',
    ].join('\n');
    const analysis = analyze(code);

    expect(labels(code, analysis, unknownAliasMutationBinding)).toEqual([
      'rest.nested.value = 2',
    ]);
    expect(labels(code, analysis, 'registry')).toContain(
      'rest.nested.value = 2'
    );
    expect(labels(code, analysis, 'rest')).not.toContain(
      'registry.shallow = 1'
    );
  });

  it('keeps equal-end hazards in canonical source order', () => {
    const code = 'const {x:r,...s}={x:t,y:a};f(q)(a);a=r=b;';
    const analysis = analyze(code);
    const tTimeline = timeline(analysis, 't');
    const expected = ['f(q)(a)', 'a=r=b', 'r=b'];

    expect(
      tTimeline.byStart.map((node) => code.slice(node.start, node.end))
    ).toEqual(expected);
    expect(
      tTimeline.byEnd.map((node) => code.slice(node.start, node.end))
    ).toEqual(expected);
  });

  it('keeps equal-start publication stable and deduplicated by node identity', () => {
    const code = [
      'import { source, sibling } from "./tokens";',
      'new source()();',
    ].join('\n');
    const first = analyze(code);
    const second = analyze(code);
    const expectedByStart = ['new source()()', 'new source()'];
    const expectedByEnd = ['new source()', 'new source()()'];

    ['source', 'sibling'].forEach((binding) => {
      const firstTimeline = timeline(first, binding);
      const secondTimeline = timeline(second, binding);
      expect(
        firstTimeline.byStart.map((node) => code.slice(node.start, node.end))
      ).toEqual(expectedByStart);
      expect(
        firstTimeline.byEnd.map((node) => code.slice(node.start, node.end))
      ).toEqual(expectedByEnd);
      expect(new Set(firstTimeline.byStart).size).toBe(2);
      expect(
        secondTimeline.byStart.map((node) => code.slice(node.start, node.end))
      ).toEqual(expectedByStart);
    });
  });
});
