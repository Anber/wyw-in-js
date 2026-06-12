// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from 'bun:test';

import { createPerfSpansAccumulator } from '../analyze';
import { isPerfSpansLine } from '../guards';

const span = (overrides: Record<string, unknown> = {}) => ({
  durationMs: 10,
  finishedAt: 15,
  isAsync: false,
  method: 'transform:preeval',
  spanId: 0,
  startedAt: 5,
  status: 'finished',
  type: 'perf-span',
  ...overrides,
});

describe('perf spans log analysis', () => {
  test('guards perf span lines and rejects malformed records', () => {
    expect(isPerfSpansLine(span())).toBe(true);
    expect(isPerfSpansLine(span({ error: { message: 'failed' } }))).toBe(true);
    expect(isPerfSpansLine(span({ durationMs: '10' }))).toBe(false);
    expect(isPerfSpansLine(span({ status: 'pending' }))).toBe(false);
    expect(isPerfSpansLine(span({ type: 'perf-span-start' }))).toBe(false);
  });

  test('aggregates sample finished and failed perf spans', () => {
    const acc = createPerfSpansAccumulator();
    acc.addLine(span({ durationMs: 10, spanId: 1 }), 1);
    acc.addLine(
      span({
        durationMs: 30,
        error: { message: 'eval failed' },
        isAsync: true,
        method: 'transform:evalFile',
        spanId: 2,
        status: 'failed',
      }),
      2
    );
    acc.addLine(
      span({
        durationMs: 5,
        isAsync: true,
        method: 'transform:preeval',
        spanId: 3,
        startedAt: 20,
      }),
      3
    );

    const stats = acc.finish();

    expect(stats.summary.totalSpans).toBe(3);
    expect(stats.summary.failedSpans).toBe(1);
    expect(stats.summary.asyncSpans).toBe(2);
    expect(stats.summary.totalDurationMs).toBe(45);
    expect(stats.summary.slowestSpans.map((item) => item.spanId)).toEqual([
      2, 1, 3,
    ]);
    expect(stats.summary.topMethods).toEqual([
      {
        asyncSpans: 1,
        avgDurationMs: 30,
        count: 1,
        failedSpans: 1,
        maxDurationMs: 30,
        method: 'transform:evalFile',
        totalDurationMs: 30,
      },
      {
        asyncSpans: 1,
        avgDurationMs: 7.5,
        count: 2,
        failedSpans: 0,
        maxDurationMs: 10,
        method: 'transform:preeval',
        totalDurationMs: 15,
      },
    ]);
  });
});
