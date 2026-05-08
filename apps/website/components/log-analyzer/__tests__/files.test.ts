// eslint-disable-next-line import/no-unresolved
import { describe, expect, test } from 'bun:test';

import { detectRequiredFiles } from '../files';

const file = (name: string) => new File(['{}\n'], name);

describe('detectRequiredFiles', () => {
  test('accepts old debug directories without eval-files.jsonl', () => {
    const actions = file('actions.jsonl');
    const dependencies = file('dependencies.jsonl');
    const entrypoints = file('entrypoints.jsonl');

    const result = detectRequiredFiles([actions, dependencies, entrypoints]);

    expect(result.problems).toEqual([]);
    expect(result.selected.actions).toBe(actions);
    expect(result.selected.dependencies).toBe(dependencies);
    expect(result.selected.entrypoints).toBe(entrypoints);
    expect(result.selected.evalFiles).toBeUndefined();
  });

  test('detects optional eval-files.jsonl when present', () => {
    const evalFiles = file('eval-files.jsonl');

    const result = detectRequiredFiles([
      file('actions.jsonl'),
      file('dependencies.jsonl'),
      file('entrypoints.jsonl'),
      evalFiles,
    ]);

    expect(result.problems).toEqual([]);
    expect(result.selected.evalFiles).toBe(evalFiles);
  });
});
