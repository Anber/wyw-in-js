import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createFileReporter } from '../debug/fileReporter';

const readActions = (dir: string) => {
  const raw = readFileSync(join(dir, 'actions.jsonl'), 'utf-8').trim();
  return raw.split('\n').map((l) => JSON.parse(l));
};

describe('fileReporter', () => {
  it('serializes Error objects in failed action logs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-filereporter-'));
    const { emitter, onDone } = createFileReporter({ dir });

    const cause = new Error('root cause');
    const error = new Error('eval failed');
    error.cause = cause;
    (error as NodeJS.ErrnoException).code = 'WYW_EVAL_TIMEOUT';

    try {
      emitter.action('evalFile', 'idx-1', 'entry.tsx', () => {
        throw error;
      });
    } catch {
      // expected — action rethrows
    }

    onDone(process.cwd());
    // streams flush async
    await new Promise((r) => setTimeout(r, 50));

    const lines = readActions(dir);
    const failLine = lines.find(
      (l: Record<string, unknown>) => l.result === 'failed'
    );

    expect(failLine).toBeDefined();
    expect(failLine.error).toBeDefined();
    // Must NOT be empty {} — Error properties must be extracted
    expect(failLine.error.message).toBe('eval failed');
    expect(failLine.error.name).toBe('Error');
    expect(failLine.error.code).toBe('WYW_EVAL_TIMEOUT');
    expect(failLine.error.stack).toContain('eval failed');
    // Nested cause
    expect(failLine.error.cause).toBeDefined();
    expect(failLine.error.cause.message).toBe('root cause');

    rmSync(dir, { recursive: true, force: true });
  });

  it('serializes non-Error values in failed action logs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wyw-filereporter-'));
    const { emitter, onDone } = createFileReporter({ dir });

    try {
      emitter.action('evalFile', 'idx-1', 'entry.tsx', () => {
        throw 'string error';
      });
    } catch {
      // expected
    }

    onDone(process.cwd());
    await new Promise((r) => setTimeout(r, 50));

    const lines = readActions(dir);
    const failLine = lines.find(
      (l: Record<string, unknown>) => l.result === 'failed'
    );

    expect(failLine).toBeDefined();
    expect(failLine.error.value).toBe('string error');

    rmSync(dir, { recursive: true, force: true });
  });
});
