import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createFileReporter } from '../debug/fileReporter';

const waitFor = async (
  predicate: () => boolean,
  { timeoutMs = 1000, intervalMs = 5 } = {}
) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor timed out');
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
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
      await waitFor(() => existsSync(target) && readFileSync(target).length > 0);

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

  it('returns a dummy reporter when no dir is provided', () => {
    const reporter = createFileReporter(false);
    expect(() => reporter.emitter.single({ type: 'staticResolve' })).not.toThrow();
    expect(() => reporter.onDone('/')).not.toThrow();
  });
});
