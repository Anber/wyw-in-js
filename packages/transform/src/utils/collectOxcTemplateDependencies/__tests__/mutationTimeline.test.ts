/* eslint-env jest */

import {
  forEachMergedTimelineStartBefore,
  forEachTimelineEndAtOrBefore,
  forEachTimelineFullyContained,
  forEachTimelineStartBefore,
  getMutationTimeline,
  hasTimelineEndAtOrBefore,
  hasTimelineStartBefore,
  hasTimelineStartInRange,
  sealMutationTimeline,
  someTimelineEndAtOrBefore,
  someTimelineFullyContained,
  someTimelineStartBefore,
  withoutTimelineNode,
} from '../mutationTimeline';
import {
  analyzeProgram,
  getRootMutationHazards,
  parseOxc,
} from '../scopeAnalysis';
import type { MutationSpan } from '../types';

type TestSpan = MutationSpan & {
  id: string;
};

const span = (id: string, start: number, end: number): TestSpan => ({
  end,
  id,
  start,
});

describe('mutation timelines', () => {
  it('seals stable immutable start and end orderings', () => {
    const equalEndFirst = span('equal-end-first', 8, 20);
    const equalStartFirst = span('equal-start-first', 4, 30);
    const equalStartSecond = span('equal-start-second', 4, 10);
    const equalEndSecond = span('equal-end-second', 1, 20);
    const sourceOrder = [
      equalEndFirst,
      equalStartFirst,
      equalStartSecond,
      equalEndSecond,
    ];

    const timeline = sealMutationTimeline(sourceOrder);

    expect(timeline.byStart.map(({ id }) => id)).toEqual([
      'equal-end-second',
      'equal-start-first',
      'equal-start-second',
      'equal-end-first',
    ]);
    expect(timeline.byEnd.map(({ id }) => id)).toEqual([
      'equal-start-second',
      'equal-end-first',
      'equal-end-second',
      'equal-start-first',
    ]);
    expect(sourceOrder).toEqual([
      equalEndFirst,
      equalStartFirst,
      equalStartSecond,
      equalEndSecond,
    ]);
    expect(Object.isFrozen(timeline)).toBe(true);
    expect(Object.isFrozen(timeline.byStart)).toBe(true);
    expect(Object.isFrozen(timeline.byEnd)).toBe(true);
  });

  it('keeps start, end, and containment boundaries distinct', () => {
    const timeline = sealMutationTimeline([
      span('outer', 1, 12),
      span('before', 2, 4),
      span('crossing', 3, 9),
      span('nested', 4, 6),
      span('at-high', 8, 8),
      span('after', 9, 10),
    ]);

    expect(hasTimelineStartBefore(timeline, 4)).toBe(true);
    expect(
      someTimelineStartBefore(timeline, 4, ({ id }) => id === 'nested')
    ).toBe(false);
    expect(hasTimelineStartInRange(timeline, 4, 8)).toBe(true);
    expect(hasTimelineStartInRange(timeline, 8, 9)).toBe(true);

    expect(hasTimelineEndAtOrBefore(timeline, 6)).toBe(true);
    expect(
      someTimelineEndAtOrBefore(timeline, 6, ({ id }) => id === 'crossing')
    ).toBe(false);
    expect(
      someTimelineEndAtOrBefore(timeline, 6, ({ id }) => id === 'nested')
    ).toBe(true);

    expect(
      someTimelineFullyContained(timeline, 4, 6, ({ id }) => id === 'nested')
    ).toBe(true);
    expect(
      someTimelineFullyContained(timeline, 4, 6, ({ id }) => id === 'crossing')
    ).toBe(false);
    expect(
      someTimelineFullyContained(timeline, 8, 8, ({ id }) => id === 'at-high')
    ).toBe(true);
    expect(someTimelineFullyContained(timeline, 9, 8, () => true)).toBe(false);
  });

  it('iterates bounded prefixes without changing their timeline order', () => {
    const timeline = sealMutationTimeline([
      span('outer', 1, 10),
      span('later-ending-first', 2, 8),
      span('inner', 3, 5),
      span('cutoff', 5, 5),
    ]);
    const starts: string[] = [];
    const ends: string[] = [];
    const contained: string[] = [];

    forEachTimelineStartBefore(timeline, 5, ({ id }) => starts.push(id));
    forEachTimelineEndAtOrBefore(timeline, 5, ({ id }) => ends.push(id));
    forEachTimelineFullyContained(timeline, 2, 8, ({ id }) =>
      contained.push(id)
    );

    expect(starts).toEqual(['outer', 'later-ending-first', 'inner']);
    expect(ends).toEqual(['inner', 'cutoff']);
    expect(contained).toEqual(['later-ending-first', 'inner', 'cutoff']);
  });

  it('uses one shared empty timeline for missing bindings', () => {
    const missing = getMutationTimeline(new Map(), 'missing');
    let visits = 0;

    expect(missing).toBe(getMutationTimeline(new Map(), 'other'));
    expect(hasTimelineStartBefore(missing, 1)).toBe(false);
    expect(hasTimelineStartInRange(missing, 0, 1)).toBe(false);
    expect(hasTimelineEndAtOrBefore(missing, 1)).toBe(false);
    expect(someTimelineStartBefore(missing, 1, () => true)).toBe(false);
    expect(someTimelineEndAtOrBefore(missing, 1, () => true)).toBe(false);
    expect(someTimelineFullyContained(missing, 0, 1, () => true)).toBe(false);
    forEachTimelineStartBefore(missing, 1, () => {
      visits += 1;
    });
    forEachTimelineEndAtOrBefore(missing, 1, () => {
      visits += 1;
    });
    forEachTimelineFullyContained(missing, 0, 1, () => {
      visits += 1;
    });
    expect(visits).toBe(0);
  });

  it('removes only the requested identity from both orderings', () => {
    const outer = span('outer', 1, 10);
    const inner = span('inner', 3, 5);
    const absent = span('absent', 3, 5);
    const timeline = sealMutationTimeline([outer, inner]);

    expect(withoutTimelineNode(timeline, absent)).toBe(timeline);
    const removed = withoutTimelineNode(timeline, outer);
    expect(removed.byStart).toEqual([inner]);
    expect(removed.byEnd).toEqual([inner]);
    expect(Object.isFrozen(removed.byStart)).toBe(true);
    const singleton = sealMutationTimeline([outer]);
    expect(withoutTimelineNode(singleton, absent)).toBe(singleton);
    expect(withoutTimelineNode(singleton, outer).byStart).toEqual([]);
  });

  it('merges equal-start groups mutation-first and deduplicates identities', () => {
    const before = span('before', 1, 2);
    const mutationFirst = span('mutation-first', 4, 8);
    const duplicate = span('duplicate', 4, 6);
    const hazardBeforeDuplicate = span('hazard-before-duplicate', 4, 5);
    const hazardAfterDuplicate = span('hazard-after-duplicate', 4, 7);
    const excluded = span('excluded', 4, 9);
    const atCutoff = span('at-cutoff', 10, 11);
    const mutations = sealMutationTimeline([
      duplicate,
      mutationFirst,
      before,
      atCutoff,
    ]);
    const hazards = sealMutationTimeline([
      hazardBeforeDuplicate,
      duplicate,
      excluded,
      hazardAfterDuplicate,
      atCutoff,
    ]);
    const visited: string[] = [];

    forEachMergedTimelineStartBefore(
      mutations,
      hazards,
      10,
      ({ id }) => id !== 'excluded',
      ({ id }) => visited.push(id)
    );

    expect(visited).toEqual([
      'before',
      'duplicate',
      'mutation-first',
      'hazard-before-duplicate',
      'hazard-after-duplicate',
    ]);
  });
});

describe('published mutation analysis timelines', () => {
  it('orders crossing call hazards independently by start and end', () => {
    const code = 'const source={}; outer(source, inner(source)); source.x;';
    const analysis = analyzeProgram(parseOxc(code, '/timeline.ts'));
    const timeline = getMutationTimeline(
      analysis.rootMutationHazardsByBinding,
      'source'
    );
    const labels = (nodes: readonly MutationSpan[]): string[] =>
      nodes.map((node) => code.slice(node.start, node.end));

    expect(labels(timeline.byStart)).toEqual([
      'outer(source, inner(source))',
      'inner(source)',
    ]);
    expect(labels(timeline.byEnd)).toEqual([
      'inner(source)',
      'outer(source, inner(source))',
    ]);

    const innerEnd = code.indexOf('inner(source)') + 'inner(source)'.length;
    const completed: string[] = [];
    forEachTimelineEndAtOrBefore(timeline, innerEnd, (node) =>
      completed.push(code.slice(node.start, node.end))
    );
    expect(completed).toEqual(['inner(source)']);
    expect(
      getRootMutationHazards(analysis.rootMutationHazardsByBinding, 'source')
    ).toBe(timeline.byStart);
  });

  it('deduplicates direct mutations repeated through alias hazards', () => {
    const code =
      'const source={x:0}; const alias=source; alias.x=1; source.x=2;';
    const analysis = analyzeProgram(parseOxc(code, '/timeline.ts'));
    const mutations = getMutationTimeline(
      analysis.rootMutationsByBinding,
      'source'
    );
    const hazards = getMutationTimeline(
      analysis.rootMutationHazardsByBinding,
      'source'
    );
    const replay: string[] = [];

    forEachMergedTimelineStartBefore(
      mutations,
      hazards,
      code.length,
      (node) =>
        node.type === 'AssignmentExpression' ||
        node.type === 'UpdateExpression',
      (node) => replay.push(code.slice(node.start, node.end))
    );

    expect(replay).toEqual(['alias.x=1', 'source.x=2']);
    expect(
      hazards.byStart.filter(
        (hazard) => code.slice(hazard.start, hazard.end) === 'source.x=2'
      )
    ).toHaveLength(1);
    expect(Object.isFrozen(mutations.byStart)).toBe(true);
    expect(Object.isFrozen(hazards.byEnd)).toBe(true);
  });
});
