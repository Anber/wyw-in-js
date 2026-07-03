import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createFileReporter } from '../debug/fileReporter';
import { EventEmitter } from '../utils/EventEmitter';

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

const hasJsonlLines = (file: string, length: number) => {
  if (!existsSync(file)) {
    return false;
  }

  const content = readFileSync(file, 'utf8');
  return (
    content.endsWith('\n') &&
    content.split('\n').filter(Boolean).length >= length
  );
};

describe('createFileReporter', () => {
  it('exposes a cheap enabled flag for debug-only work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      expect(EventEmitter.dummy.enabled).toBe(false);
      expect(reporter.emitter.enabled).toBe(true);
    } finally {
      reporter.onDone(dir);
      await waitFor(() => existsSync(join(dir, 'actions.jsonl')));
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('writes staticPlan single events to static-plan.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      reporter.emitter.single({
        filename: join(dir, 'foo.ts'),
        needCount: 1,
        runtimeDependencyCount: 2,
        staticValueCount: 3,
        type: 'staticPlan',
        unresolvedCount: 4,
        usageCount: 5,
      });

      reporter.onDone(dir);
      const target = join(dir, 'static-plan.jsonl');
      await waitFor(
        () => existsSync(target) && readFileSync(target).length > 0
      );

      const events = readJsonl(target);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          needCount: 1,
          runtimeDependencyCount: 2,
          staticValueCount: 3,
          type: 'staticPlan',
          unresolvedCount: 4,
          usageCount: 5,
        })
      );
      expect(events[0].filename).toContain('foo.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes eval file payloads to eval-files.jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-file-reporter-'));
    const reporter = createFileReporter({ dir });

    try {
      const values = {
        exports: {
          color: {
            serialized: { kind: 'string', value: 'red' },
            status: 'serialized',
          },
        },
      };

      reporter.emitter.single({
        contentBase64: Buffer.from('export const color = "red";').toString(
          'base64'
        ),
        evalSeq: 1,
        hash: 'content-hash',
        id: join(dir, 'theme.ts'),
        importer: null,
        only: ['color'],
        payloadKind: 'code',
        request: null,
        type: 'eval-file',
        valuesBase64: Buffer.from(JSON.stringify(values)).toString('base64'),
      });

      reporter.onDone(dir);

      const target = join(dir, 'eval-files.jsonl');
      await waitFor(
        () => existsSync(target) && readFileSync(target).length > 0
      );

      const events = readJsonl(target);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          evalSeq: 1,
          hash: 'content-hash',
          only: ['color'],
          payloadKind: 'code',
          type: 'eval-file',
        })
      );
      expect(events[0].id).toContain('theme.ts');
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
      await waitFor(() => hasJsonlLines(perfTarget, 1));

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

      const actionsTarget = join(dir, 'actions.jsonl');
      await waitFor(() => hasJsonlLines(actionsTarget, 2));

      const actionEvents = readJsonl(actionsTarget);
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
      await waitFor(() => hasJsonlLines(perfTarget, 3));

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
