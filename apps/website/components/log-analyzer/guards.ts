import type {
  ActionLine,
  DependenciesLine,
  EntrypointLine,
  EvalFilesLine,
  PerfSpanLine,
} from './types';

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

export function isEvalFilesLine(value: unknown): value is EvalFilesLine {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === 'eval-file' &&
    typeof v.evalSeq === 'number' &&
    typeof v.id === 'string' &&
    (typeof v.importer === 'string' || v.importer === null) &&
    (typeof v.request === 'string' || v.request === null) &&
    Array.isArray(v.only) &&
    (v.payloadKind === 'code' || v.payloadKind === 'serialized-exports') &&
    (typeof v.hash === 'string' || v.hash === null) &&
    (typeof v.contentBase64 === 'string' || v.contentBase64 === null) &&
    (typeof v.valuesBase64 === 'string' || v.valuesBase64 === null)
  );
}

export function isPerfSpansLine(value: unknown): value is PerfSpanLine {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === 'perf-span' &&
    typeof v.method === 'string' &&
    typeof v.spanId === 'number' &&
    typeof v.startedAt === 'number' &&
    typeof v.finishedAt === 'number' &&
    typeof v.durationMs === 'number' &&
    typeof v.isAsync === 'boolean' &&
    (v.status === 'finished' || v.status === 'failed')
  );
}
