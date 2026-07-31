import type { MutationSpan, MutationTimeline } from './types';

type TimelinePredicate<T extends MutationSpan> = (node: T) => boolean;
type TimelineVisitor<T extends MutationSpan> = (node: T) => void;

const emptyTimelineNodes = Object.freeze([]) as readonly never[];

export const emptyMutationTimeline: MutationTimeline<never> = Object.freeze({
  byEnd: emptyTimelineNodes,
  byStart: emptyTimelineNodes,
});

const lowerBoundStart = <T extends MutationSpan>(
  nodes: readonly T[],
  point: number
): number => {
  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (nodes[middle]!.start < point) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

const upperBoundStart = <T extends MutationSpan>(
  nodes: readonly T[],
  point: number
): number => {
  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (nodes[middle]!.start <= point) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

const upperBoundEnd = <T extends MutationSpan>(
  nodes: readonly T[],
  point: number
): number => {
  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (nodes[middle]!.end <= point) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
};

const someTimelineRange = <T extends MutationSpan>(
  nodes: readonly T[],
  from: number,
  to: number,
  predicate: TimelinePredicate<T>
): boolean => {
  for (let index = from; index < to; index += 1) {
    if (predicate(nodes[index]!)) {
      return true;
    }
  }
  return false;
};

export const sealMutationTimeline = <T extends MutationSpan>(
  nodes: readonly T[]
): MutationTimeline<T> => {
  if (nodes.length === 0) {
    return emptyMutationTimeline;
  }

  const byStart = Object.freeze(
    [...nodes].sort((left, right) => left.start - right.start)
  );
  const byEnd = Object.freeze(
    [...nodes].sort((left, right) => left.end - right.end)
  );
  return Object.freeze({ byEnd, byStart });
};

export const sealMutationTimelineMap = <T extends MutationSpan>(
  nodesByBinding: ReadonlyMap<string, readonly T[]>
): ReadonlyMap<string, MutationTimeline<T>> => {
  const timelines = new Map<string, MutationTimeline<T>>();
  nodesByBinding.forEach((nodes, binding) => {
    timelines.set(binding, sealMutationTimeline(nodes));
  });
  return timelines;
};

export const withoutTimelineNode = <T extends MutationSpan>(
  timeline: MutationTimeline<T>,
  node: T
): MutationTimeline<T> => {
  if (!timeline.byStart.includes(node)) {
    return timeline;
  }
  if (timeline.byStart.length === 1) {
    return emptyMutationTimeline;
  }

  return Object.freeze({
    byEnd: Object.freeze(
      timeline.byEnd.filter((candidate) => candidate !== node)
    ),
    byStart: Object.freeze(
      timeline.byStart.filter((candidate) => candidate !== node)
    ),
  });
};

export const getMutationTimeline = <T extends MutationSpan>(
  timelines: ReadonlyMap<string, MutationTimeline<T>>,
  binding: string
): MutationTimeline<T> => timelines.get(binding) ?? emptyMutationTimeline;

export const hasTimelineStartBefore = <T extends MutationSpan>(
  timeline: MutationTimeline<T>,
  point: number
): boolean => lowerBoundStart(timeline.byStart, point) > 0;

export const timelineStartBeforeIncludes = <T extends MutationSpan>(
  timeline: MutationTimeline<T>,
  point: number,
  candidate: MutationSpan
): boolean => {
  if (candidate.start >= point) {
    return false;
  }

  const { byStart } = timeline;
  let index = lowerBoundStart(byStart, candidate.start);
  while (index < byStart.length && byStart[index]!.start === candidate.start) {
    if (byStart[index] === candidate) {
      return true;
    }
    index += 1;
  }
  return false;
};

export const hasTimelineStartInRange = <T extends MutationSpan>(
  timeline: MutationTimeline<T>,
  low: number,
  high: number
): boolean =>
  low < high &&
  lowerBoundStart(timeline.byStart, low) <
    lowerBoundStart(timeline.byStart, high);

export const hasTimelineEndAtOrBefore = <T extends MutationSpan>(
  timeline: MutationTimeline<T>,
  point: number
): boolean => upperBoundEnd(timeline.byEnd, point) > 0;

export const someTimelineStartBefore = <T extends MutationSpan>(
  timeline: MutationTimeline<T>,
  point: number,
  predicate: TimelinePredicate<T>
): boolean =>
  someTimelineRange(
    timeline.byStart,
    0,
    lowerBoundStart(timeline.byStart, point),
    predicate
  );

export const someTimelineEndAtOrBefore = <T extends MutationSpan>(
  timeline: MutationTimeline<T>,
  point: number,
  predicate: TimelinePredicate<T>
): boolean =>
  someTimelineRange(
    timeline.byEnd,
    0,
    upperBoundEnd(timeline.byEnd, point),
    predicate
  );

export const someTimelineFullyContained = <T extends MutationSpan>(
  timeline: MutationTimeline<T>,
  low: number,
  high: number,
  predicate: TimelinePredicate<T>
): boolean => {
  if (low > high) {
    return false;
  }

  const { byStart } = timeline;
  const from = lowerBoundStart(byStart, low);
  const to = upperBoundStart(byStart, high);
  for (let index = from; index < to; index += 1) {
    const node = byStart[index]!;
    if (node.end <= high && predicate(node)) {
      return true;
    }
  }
  return false;
};

export const forEachTimelineStartBefore = <T extends MutationSpan>(
  timeline: MutationTimeline<T>,
  point: number,
  visitor: TimelineVisitor<T>
): void => {
  const { byStart } = timeline;
  const to = lowerBoundStart(byStart, point);
  for (let index = 0; index < to; index += 1) {
    visitor(byStart[index]!);
  }
};

export const forEachTimelineEndAtOrBefore = <T extends MutationSpan>(
  timeline: MutationTimeline<T>,
  point: number,
  visitor: TimelineVisitor<T>
): void => {
  const { byEnd } = timeline;
  const to = upperBoundEnd(byEnd, point);
  for (let index = 0; index < to; index += 1) {
    visitor(byEnd[index]!);
  }
};

export const forEachTimelineFullyContained = <T extends MutationSpan>(
  timeline: MutationTimeline<T>,
  low: number,
  high: number,
  visitor: TimelineVisitor<T>
): void => {
  if (low > high) {
    return;
  }

  const { byStart } = timeline;
  const from = lowerBoundStart(byStart, low);
  const to = upperBoundStart(byStart, high);
  for (let index = from; index < to; index += 1) {
    const node = byStart[index]!;
    if (node.end <= high) {
      visitor(node);
    }
  }
};

const timelineGroupContains = <T extends MutationSpan>(
  nodes: readonly T[],
  from: number,
  to: number,
  candidate: MutationSpan
): boolean => {
  for (let index = from; index < to; index += 1) {
    if (nodes[index] === candidate) {
      return true;
    }
  }
  return false;
};

export const forEachMergedTimelineStartBefore = <
  TPrimary extends MutationSpan,
  TSecondary extends MutationSpan,
>(
  primary: MutationTimeline<TPrimary>,
  secondary: MutationTimeline<TSecondary>,
  point: number,
  includeSecondary: TimelinePredicate<TSecondary>,
  visitor: TimelineVisitor<TPrimary | TSecondary>
): void => {
  const primaryNodes = primary.byStart;
  const secondaryNodes = secondary.byStart;
  const primaryLimit = lowerBoundStart(primaryNodes, point);
  const secondaryLimit = lowerBoundStart(secondaryNodes, point);
  let primaryIndex = 0;
  let secondaryIndex = 0;

  while (primaryIndex < primaryLimit || secondaryIndex < secondaryLimit) {
    const nextStart = Math.min(
      primaryIndex < primaryLimit
        ? primaryNodes[primaryIndex]!.start
        : Number.POSITIVE_INFINITY,
      secondaryIndex < secondaryLimit
        ? secondaryNodes[secondaryIndex]!.start
        : Number.POSITIVE_INFINITY
    );
    const primaryGroupStart = primaryIndex;
    while (
      primaryIndex < primaryLimit &&
      primaryNodes[primaryIndex]!.start === nextStart
    ) {
      visitor(primaryNodes[primaryIndex]!);
      primaryIndex += 1;
    }

    while (
      secondaryIndex < secondaryLimit &&
      secondaryNodes[secondaryIndex]!.start === nextStart
    ) {
      const node = secondaryNodes[secondaryIndex]!;
      if (
        includeSecondary(node) &&
        !timelineGroupContains(
          primaryNodes,
          primaryGroupStart,
          primaryIndex,
          node
        )
      ) {
        visitor(node);
      }
      secondaryIndex += 1;
    }
  }
};
