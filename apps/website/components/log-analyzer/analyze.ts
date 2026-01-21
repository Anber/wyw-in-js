import type {
  ActionLine,
  ActionRecord,
  ActionsSummary,
  DependenciesLine,
  DependenciesStats,
  EntrypointFileStats,
  EntrypointInstance,
  EntrypointLine,
} from './types';

export function getCommonPathPrefix(rawPaths: string[]) {
  const paths = rawPaths
    .map((p) => p.replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((p) => !p.startsWith('[')); // ignore placeholders like "[IGNORED]"

  if (paths.length < 2) return '';

  let prefix = paths[0];
  for (const p of paths.slice(1)) {
    const max = Math.min(prefix.length, p.length);
    let i = 0;
    while (i < max && prefix[i] === p[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) return '';
  }

  const slash = prefix.lastIndexOf('/');
  if (slash === -1) return '';
  return prefix.slice(0, slash + 1);
}

export function trimPathPrefix(path: string, prefix: string) {
  if (!prefix) return path;
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith(prefix)) {
    return normalized.slice(prefix.length);
  }
  return normalized;
}

export function getPackageName(specifier: string) {
  const normalized = specifier.replace(/\\/g, '/').split(/[?#]/, 1)[0];

  const nodeModulesMarker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(nodeModulesMarker);

  if (markerIndex !== -1) {
    let tail = normalized.slice(markerIndex + nodeModulesMarker.length);
    tail = tail.replace(/^\/+/, '');
    while (tail.startsWith('node_modules/')) {
      tail = tail.slice('node_modules/'.length);
    }

    if (!tail || tail === 'node_modules') return '(unknown)';

    if (tail.startsWith('@')) {
      const parts = tail.split('/');
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
      return tail;
    }

    const [name] = tail.split('/');
    return name || '(unknown)';
  }

  const nodeModulesPrefix = 'node_modules/';
  if (normalized.startsWith(nodeModulesPrefix)) {
    let tail = normalized.slice(nodeModulesPrefix.length);
    tail = tail.replace(/^\/+/, '');
    while (tail.startsWith('node_modules/')) {
      tail = tail.slice('node_modules/'.length);
    }

    if (!tail || tail === 'node_modules') return '(unknown)';

    if (tail.startsWith('@')) {
      const parts = tail.split('/');
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
      return tail;
    }

    const [name] = tail.split('/');
    return name || '(unknown)';
  }

  // Most local paths in our logs are already resolved as "src/..." (not import
  // specifiers). Keep them under a single bucket to avoid topPackages being
  // dominated by "src" / "node_modules".
  if (
    normalized.startsWith('src/') ||
    normalized.startsWith('.') ||
    normalized.startsWith('/') ||
    normalized.startsWith('\\') ||
    /^[a-zA-Z]:\//.test(normalized)
  ) {
    return '(project)';
  }

  if (normalized.startsWith('@')) {
    const parts = normalized.split('/');
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return normalized;
  }

  const [name] = normalized.split('/');
  return name || '(unknown)';
}

export function createEntrypointsAccumulator() {
  const entrypointRefToFilename = new Map<string, string>();
  const seqIdToInstance = new Map<number, EntrypointInstance>();
  const fileStats = new Map<string, EntrypointFileStats>();

  const getOrCreateStats = (filename: string) => {
    const prev = fileStats.get(filename);
    if (prev) return prev;

    const next: EntrypointFileStats = {
      filename,
      createdCount: 0,
      supersededCount: 0,
      onlyMin: null,
      onlyMax: null,
    };
    fileStats.set(filename, next);
    return next;
  };

  const addCreated = (instance: EntrypointInstance) => {
    if (!instance.filename) return;
    const stats = getOrCreateStats(instance.filename);
    stats.createdCount += 1;

    if (typeof instance.onlyLen === 'number') {
      stats.onlyMin =
        stats.onlyMin === null
          ? instance.onlyLen
          : Math.min(stats.onlyMin, instance.onlyLen);
      stats.onlyMax =
        stats.onlyMax === null
          ? instance.onlyLen
          : Math.max(stats.onlyMax, instance.onlyLen);
    }
  };

  const addSuperseded = (instance: EntrypointInstance) => {
    if (!instance.filename) return;
    const stats = getOrCreateStats(instance.filename);
    stats.supersededCount += 1;
  };

  const addLine = (line: EntrypointLine) => {
    const [seqId, timestamp, event] = line;

    const instance =
      seqIdToInstance.get(seqId) ??
      ({
        seqId,
      } satisfies EntrypointInstance);
    seqIdToInstance.set(seqId, instance);

    if (event.type === 'created') {
      instance.createdAt = timestamp;
      instance.filename = event.filename;
      instance.idx = event.idx;
      instance.generation = event.generation;
      instance.onlyLen = event.only.length;
      instance.parentId = event.parentId;

      const ref = `${event.idx}#${event.generation}`;
      instance.ref = ref;
      entrypointRefToFilename.set(ref, event.filename);

      addCreated(instance);
    } else if (event.type === 'superseded') {
      instance.supersededAt = timestamp;
      instance.supersededWith = event.with;
      addSuperseded(instance);
    }
  };

  const finish = () => {
    const files = Array.from(fileStats.values()).sort((a, b) => {
      if (b.supersededCount !== a.supersededCount) {
        return b.supersededCount - a.supersededCount;
      }

      const growthA =
        a.onlyMax !== null && a.onlyMin !== null ? a.onlyMax - a.onlyMin : 0;
      const growthB =
        b.onlyMax !== null && b.onlyMin !== null ? b.onlyMax - b.onlyMin : 0;
      if (growthB !== growthA) return growthB - growthA;

      return a.filename.localeCompare(b.filename);
    });

    return {
      entrypointRefToFilename,
      instances: Array.from(seqIdToInstance.values()).sort(
        (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)
      ),
      files,
    };
  };

  return { addLine, finish, entrypointRefToFilename };
}

export function analyzeEntrypoints(lines: EntrypointLine[]) {
  const acc = createEntrypointsAccumulator();
  for (const line of lines) {
    acc.addLine(line);
  }
  return acc.finish();
}

function computeExclusiveByType(actions: ActionRecord[]) {
  const actionsById = new Map(actions.map((a) => [a.actionId, a]));
  const events: Array<
    | { id: number; kind: 'start'; t: number }
    | { id: number; kind: 'end'; t: number }
  > = [];

  for (const a of actions) {
    events.push({ id: a.actionId, kind: 'start', t: a.startedAt });
    events.push({ id: a.actionId, kind: 'end', t: a.finishedAt });
  }

  events.sort((a, b) => {
    if (a.t !== b.t) return a.t - b.t;
    // close before open at the same timestamp
    if (a.kind === b.kind) return 0;
    return a.kind === 'end' ? -1 : 1;
  });

  const stack: number[] = [];
  const exclusive = new Map<string, number>();

  let prevT = events[0]?.t ?? 0;
  for (const e of events) {
    const dt = e.t - prevT;
    if (dt > 0 && stack.length > 0) {
      const topId = stack[stack.length - 1];
      const type = actionsById.get(topId)?.type ?? 'unknown';
      exclusive.set(type, (exclusive.get(type) ?? 0) + dt);
    }

    prevT = e.t;

    if (e.kind === 'start') {
      stack.push(e.id);
    } else {
      const idx = stack.lastIndexOf(e.id);
      if (idx !== -1) {
        stack.splice(idx, 1);
      }
    }
  }

  return exclusive;
}

export function createActionsAccumulator(
  entrypointRefToFilename: Map<string, string>
) {
  const actionsById = new Map<number, Partial<ActionRecord>>();

  let startedAt: number | null = null;
  let finishedAt: number | null = null;

  const addLine = (line: ActionLine) => {
    if ('startedAt' in line) {
      const prev = actionsById.get(line.actionId) ?? {};
      actionsById.set(line.actionId, {
        ...prev,
        actionId: line.actionId,
        type: line.type,
        entrypointRef: line.entrypointRef,
        actionIdx: line.idx,
        startedAt: line.startedAt,
      });

      startedAt =
        startedAt === null
          ? line.startedAt
          : Math.min(startedAt, line.startedAt);
    } else if ('finishedAt' in line) {
      const prev = actionsById.get(line.actionId) ?? {};
      actionsById.set(line.actionId, {
        ...prev,
        actionId: line.actionId,
        finishedAt: line.finishedAt,
        isAsync: line.isAsync,
        result: line.result,
        error: line.error,
      });

      finishedAt =
        finishedAt === null
          ? line.finishedAt
          : Math.max(finishedAt, line.finishedAt);
    }
  };

  const finish = () => {
    const actions: ActionRecord[] = [];
    const inclusiveMsByType = new Map<string, number>();

    let finishedActions = 0;
    let failedActions = 0;
    let asyncActions = 0;

    for (const partial of actionsById.values()) {
      if (
        typeof partial.actionId !== 'number' ||
        typeof partial.type !== 'string' ||
        typeof partial.entrypointRef !== 'string' ||
        typeof partial.actionIdx !== 'string' ||
        typeof partial.startedAt !== 'number' ||
        typeof partial.finishedAt !== 'number' ||
        typeof partial.isAsync !== 'boolean' ||
        (partial.result !== 'finished' && partial.result !== 'failed')
      ) {
        // skip malformed action pair
      } else {
        const durationMs = partial.finishedAt - partial.startedAt;
        const record: ActionRecord = {
          actionId: partial.actionId,
          type: partial.type,
          entrypointRef: partial.entrypointRef,
          actionIdx: partial.actionIdx,
          startedAt: partial.startedAt,
          finishedAt: partial.finishedAt,
          durationMs,
          isAsync: partial.isAsync,
          result: partial.result,
          error: partial.error,
        };

        inclusiveMsByType.set(
          record.type,
          (inclusiveMsByType.get(record.type) ?? 0) + record.durationMs
        );

        finishedActions += 1;
        if (record.result === 'failed') failedActions += 1;
        if (record.isAsync) asyncActions += 1;

        actions.push(record);
      }
    }

    actions.sort((a, b) => b.durationMs - a.durationMs);

    const exclusiveMsByType = computeExclusiveByType(actions);

    const toTopList = (m: Map<string, number>) => {
      return Array.from(m.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([type, ms]) => [type, Math.round(ms)] as [string, number]);
    };

    const spanMs =
      startedAt !== null && finishedAt !== null ? finishedAt - startedAt : 0;

    const summary: ActionsSummary = {
      spanMs: Math.round(spanMs),
      startedAt,
      finishedAt,
      totalActions: actionsById.size,
      finishedActions,
      failedActions,
      asyncActions,
      topTypesByInclusiveMs: toTopList(inclusiveMsByType),
      topTypesByExclusiveMs: toTopList(exclusiveMsByType),
    };

    const withNames = actions.map((a) => ({
      ...a,
      entrypointFilename: entrypointRefToFilename.get(a.entrypointRef),
    }));

    return { actions: withNames, summary };
  };

  return { addLine, finish };
}

export function analyzeActions(
  lines: ActionLine[],
  entrypointRefToFilename: Map<string, string>
) {
  const acc = createActionsAccumulator(entrypointRefToFilename);
  for (const line of lines) {
    acc.addLine(line);
  }
  return acc.finish();
}

export function createDependenciesAccumulator() {
  const importersByFrom = new Map<string, Set<string>>();
  const importCountByFrom = new Map<string, number>();
  const packageCounts = new Map<string, number>();
  const files = new Set<string>();

  let importsCount = 0;

  const addLine = (line: DependenciesLine) => {
    if (typeof line.file === 'string') {
      files.add(line.file);
    }

    if (!Array.isArray(line.imports)) return;

    for (const imp of line.imports) {
      const { from } = (imp ?? {}) as { from?: unknown };
      if (typeof from !== 'string') {
        // skip malformed import record
      } else {
        importsCount += 1;

        importCountByFrom.set(from, (importCountByFrom.get(from) ?? 0) + 1);
        const importers = importersByFrom.get(from) ?? new Set<string>();
        importers.add(line.file);
        importersByFrom.set(from, importers);

        const pkg = getPackageName(from);
        packageCounts.set(pkg, (packageCounts.get(pkg) ?? 0) + 1);
      }
    }
  };

  const finish = (): DependenciesStats => {
    const topImports = Array.from(importCountByFrom.entries())
      .map(([from, count]) => ({
        from,
        count,
        importers: Array.from(importersByFrom.get(from) ?? []).sort(),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

    const topPackages = Array.from(packageCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    return {
      files: Array.from(files).sort(),
      filesCount: files.size,
      importsCount,
      topImports,
      topPackages,
      importersByFrom,
      importCountByFrom,
    };
  };

  return { addLine, finish, importersByFrom };
}

export function analyzeDependencies(
  lines: DependenciesLine[]
): DependenciesStats {
  const acc = createDependenciesAccumulator();
  for (const line of lines) {
    acc.addLine(line);
  }
  return acc.finish();
}

export function getSupersedeChain(
  instances: EntrypointInstance[],
  startSeqId: number
) {
  const bySeqId = new Map(instances.map((i) => [i.seqId, i]));
  const chain: EntrypointInstance[] = [];

  const visited = new Set<number>();
  let cur: number | undefined = startSeqId;

  while (cur !== undefined) {
    if (visited.has(cur)) break;
    visited.add(cur);

    const instance = bySeqId.get(cur);
    if (!instance) break;

    chain.push(instance);
    cur = instance.supersededWith;
  }

  return chain;
}

export function isEntrypointRef(ref: string) {
  // BaseEntrypoint.ref is `${idx}#${generation}`.
  return /^[0-9a-f]+#[0-9]+$/i.test(ref);
}
