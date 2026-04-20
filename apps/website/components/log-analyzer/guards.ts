import type { ActionLine, DependenciesLine, EntrypointLine } from './types';

export function isActionLine(value: unknown): value is ActionLine {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.actionId !== 'number') return false;

  if (typeof v.startedAt === 'number') {
    return (
      typeof v.entrypointRef === 'string' &&
      typeof v.idx === 'string' &&
      typeof v.type === 'string'
    );
  }

  if (typeof v.finishedAt === 'number') {
    return (
      typeof v.isAsync === 'boolean' &&
      (v.result === 'finished' || v.result === 'failed')
    );
  }

  return false;
}

export function isDependenciesLine(value: unknown): value is DependenciesLine {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.file === 'string' &&
    typeof v.fileIdx === 'string' &&
    Array.isArray(v.only) &&
    Array.isArray(v.imports)
  );
}

export function isEntrypointLine(value: unknown): value is EntrypointLine {
  if (!Array.isArray(value) || value.length !== 3) return false;
  const [seqId, timestamp, event] = value as [unknown, unknown, unknown];
  if (typeof seqId !== 'number' || typeof timestamp !== 'number') return false;
  if (!event || typeof event !== 'object') return false;
  const e = event as Record<string, unknown>;
  return (
    typeof e.type === 'string' &&
    (e.type === 'created' ||
      e.type === 'superseded' ||
      e.type === 'actionCreated' ||
      e.type === 'setTransformResult')
  );
}
