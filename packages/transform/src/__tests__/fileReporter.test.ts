import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createFileReporter } from '../debug/fileReporter';

const delay = (intervalMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, intervalMs);
  });

const waitFor = async (
  predicate: () => boolean,
  { timeoutMs = 1000, intervalMs = 5 } = {}
) => {
  const startedAt = Date.now();
  const poll = async (): Promise<void> => {
    if (predicate()) {
      return;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor timed out');
    }

    await delay(intervalMs);
    await poll();
  };

  await poll();
};

const readJsonl = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe('createFileReporter', () => {
  it('writes staticResolve single events to static-resolve.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      reporter.emitter.single({
        filename: join(dir, 'foo.ts'),
        phase: 'export',
        reason: 'unsupported-expression',
        status: 'rejected',
        type: 'staticResolve',
      });
      reporter.emitter.single({
        candidate: '_exp',
        filename: join(dir, 'foo.ts'),
        phase: 'candidate',
        status: 'resolved',
        type: 'staticResolve',
      });
      // unrelated single events should not land in the static-resolve stream
      reporter.emitter.single({
        file: join(dir, 'foo.ts'),
        fileIdx: 'idx',
        imports: [],
        only: ['*'],
        type: 'dependency',
      });

      reporter.onDone(dir);
      const target = join(dir, 'static-resolve.jsonl');
      await waitFor(
        () => existsSync(target) && readFileSync(target).length > 0
      );

      const events = readJsonl(target);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(
        expect.objectContaining({
          phase: 'export',
          reason: 'unsupported-expression',
          status: 'rejected',
          type: 'staticResolve',
        })
      );
      expect(events[1]).toEqual(
        expect.objectContaining({
          candidate: '_exp',
          phase: 'candidate',
          status: 'resolved',
          type: 'staticResolve',
        })
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes perf spans to perf-spans.jsonl without changing actions.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      const result = reporter.emitter.perf('transform:preeval', () => 42);
      reporter.emitter.action('workflow', '000001:1', '00001#1', () => {});

      reporter.onDone(dir);

      expect(result).toBe(42);

      const perfTarget = join(dir, 'perf-spans.jsonl');
      await waitFor(
        () => existsSync(perfTarget) && readFileSync(perfTarget).length > 0
      );

      const perfEvents = readJsonl(perfTarget);
      expect(perfEvents).toHaveLength(1);
      expect(perfEvents[0]).toEqual(
        expect.objectContaining({
          isAsync: false,
          method: 'transform:preeval',
          spanId: 0,
          status: 'finished',
          type: 'perf-span',
        })
      );
      expect(perfEvents[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(perfEvents[0].finishedAt).toBeGreaterThanOrEqual(
        perfEvents[0].startedAt
      );

      const actionEvents = readJsonl(join(dir, 'actions.jsonl'));
      expect(actionEvents).toEqual([
        expect.objectContaining({
          actionId: 0,
          entrypointRef: '00001#1',
          idx: '000001:1',
          startedAt: expect.any(Number),
          type: 'workflow',
        }),
        expect.objectContaining({
          actionId: 0,
          finishedAt: expect.any(Number),
          isAsync: false,
          result: 'finished',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records failed and concurrent async perf spans independently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      await expect(
        reporter.emitter.perf('transform:evalFile', async () => {
          await delay(1);
          throw new Error('eval failed');
        })
      ).rejects.toThrow('eval failed');

      await Promise.all([
        reporter.emitter.perf('transform:preeval', () => delay(2)),
        reporter.emitter.perf('transform:preeval', () => delay(1)),
      ]);

      reporter.onDone(dir);

      const perfTarget = join(dir, 'perf-spans.jsonl');
      await waitFor(
        () => existsSync(perfTarget) && readFileSync(perfTarget).length > 0
      );

      const perfEvents = readJsonl(perfTarget);
      expect(perfEvents).toHaveLength(3);

      expect(perfEvents[0]).toEqual(
        expect.objectContaining({
          isAsync: true,
          method: 'transform:evalFile',
          spanId: 0,
          status: 'failed',
          type: 'perf-span',
        })
      );
      expect(perfEvents[0].error).toBeDefined();

      const preevalSpans = perfEvents.filter(
        (event) => event.method === 'transform:preeval'
      );
      expect(preevalSpans).toHaveLength(2);
      expect(preevalSpans.map((event) => event.spanId).sort()).toEqual([1, 2]);
      expect(preevalSpans.every((event) => event.status === 'finished')).toBe(
        true
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a dummy reporter when no dir is provided', () => {
    const reporter = createFileReporter(false);
    expect(() =>
      reporter.emitter.single({ type: 'staticResolve' })
    ).not.toThrow();
    expect(() => reporter.onDone('/')).not.toThrow();
  });
});
