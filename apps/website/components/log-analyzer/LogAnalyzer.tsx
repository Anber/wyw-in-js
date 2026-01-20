import * as React from 'react';

import type { JsonlParseError, JsonlProgress } from './jsonl';
import { parseJsonlFile } from './jsonl';
import {
  createActionsAccumulator,
  createDependenciesAccumulator,
  createEntrypointsAccumulator,
  getCommonPathPrefix,
  getSupersedeChain,
  trimPathPrefix,
} from './analyze';
import type {
  ActionLine,
  ActionRecord,
  ActionsSummary,
  DependenciesLine,
  DependenciesStats,
  EntrypointLine,
  EntrypointFileStats,
  EntrypointInstance,
} from './types';

type RequiredFiles = {
  actions?: File;
  dependencies?: File;
  entrypoints?: File;
};

type ParseErrors = {
  actions: JsonlParseError[];
  dependencies: JsonlParseError[];
  entrypoints: JsonlParseError[];
};

type ParsedData = {
  actions: ActionRecord[];
  actionsSummary: ActionsSummary;
  dependencies: DependenciesStats;
  entrypointsFiles: EntrypointFileStats[];
  entrypointsInstances: EntrypointInstance[];
  pathPrefix: string;
  skippedLines: {
    actions: number;
    dependencies: number;
    entrypoints: number;
  };
};

type ParseProgress = {
  file: keyof RequiredFiles;
  progress: JsonlProgress;
};

const REQUIRED_FILENAMES: Array<keyof RequiredFiles> = [
  'actions',
  'dependencies',
  'entrypoints',
];

const FILE_NAME_BY_KEY: Record<keyof RequiredFiles, string> = {
  actions: 'actions.jsonl',
  dependencies: 'dependencies.jsonl',
  entrypoints: 'entrypoints.jsonl',
};

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const idx = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const v = bytes / 1024 ** idx;
  return `${v.toFixed(v >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatMs(ms: number) {
  if (!Number.isFinite(ms)) return '–';
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = s / 60;
  return `${m.toFixed(2)} min`;
}

function detectRequiredFiles(files: File[]) {
  const byName = new Map<string, File[]>();
  for (const f of files) {
    const list = byName.get(f.name) ?? [];
    list.push(f);
    byName.set(f.name, list);
  }

  const required: RequiredFiles = {};
  const problems: string[] = [];

  for (const key of REQUIRED_FILENAMES) {
    const expected = FILE_NAME_BY_KEY[key];
    const matches = byName.get(expected) ?? [];

    if (matches.length === 0) {
      problems.push(`Missing ${expected}`);
    } else if (matches.length > 1) {
      problems.push(
        `Multiple files named ${expected} found (${matches.length}). Upload exactly one run.`
      );
    } else {
      const [file] = matches;
      required[key] = file;
    }
  }

  return { required, problems };
}

function isActionLine(value: unknown): value is ActionLine {
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

function isDependenciesLine(value: unknown): value is DependenciesLine {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.file === 'string' &&
    typeof v.fileIdx === 'string' &&
    Array.isArray(v.only) &&
    Array.isArray(v.imports)
  );
}

function isEntrypointLine(value: unknown): value is EntrypointLine {
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

const DirectoryInput = ({
  disabled,
  onFiles,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) => {
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  }, []);

  return (
    <input
      ref={inputRef}
      type="file"
      multiple
      disabled={disabled}
      onChange={(e) => onFiles(Array.from(e.currentTarget.files ?? []))}
    />
  );
};

export function LogAnalyzer() {
  const [selected, setSelected] = React.useState<RequiredFiles>({});
  const [problems, setProblems] = React.useState<string[]>([]);

  const [parseProgress, setParseProgress] =
    React.useState<ParseProgress | null>(null);

  const [isParsing, setIsParsing] = React.useState(false);
  const [parseErrors, setParseErrors] = React.useState<ParseErrors | null>(
    null
  );
  const [data, setData] = React.useState<ParsedData | null>(null);
  const [fatalError, setFatalError] = React.useState<string | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  const lastProgressUpdateRef = React.useRef(0);

  const reset = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    setSelected({});
    setProblems([]);
    setParseProgress(null);
    setIsParsing(false);
    setParseErrors(null);
    setData(null);
    setFatalError(null);
  }, []);

  const onPickFiles = React.useCallback((files: File[]) => {
    const { required, problems: nextProblems } = detectRequiredFiles(files);
    setSelected(required);
    setProblems(nextProblems);
    setParseErrors(null);
    setData(null);
    setFatalError(null);
  }, []);

  const onDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (isParsing) return;
      onPickFiles(Array.from(e.dataTransfer.files ?? []));
    },
    [isParsing, onPickFiles]
  );

  const canParse = REQUIRED_FILENAMES.every((k) => selected[k]);

  const parse = React.useCallback(async () => {
    if (!canParse) return;

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setIsParsing(true);
    setParseErrors(null);
    setData(null);
    setFatalError(null);
    setProblems([]);

    const skippedLines = {
      actions: 0,
      dependencies: 0,
      entrypoints: 0,
    };

    const updateProgress =
      (file: keyof RequiredFiles) => (p: JsonlProgress) => {
        const now = performance.now();
        if (now - lastProgressUpdateRef.current < 120) return;
        lastProgressUpdateRef.current = now;
        setParseProgress({ file, progress: p });
      };

    try {
      const entryAcc = createEntrypointsAccumulator();
      const entryParse = await parseJsonlFile<unknown>(
        selected.entrypoints!,
        (value) => {
          if (!isEntrypointLine(value)) {
            skippedLines.entrypoints += 1;
            return;
          }
          entryAcc.addLine(value as EntrypointLine);
        },
        {
          signal: abort.signal,
          onProgress: updateProgress('entrypoints'),
        }
      );

      const entry = entryAcc.finish();

      const actionsAcc = createActionsAccumulator(
        entry.entrypointRefToFilename
      );
      const actionsParse = await parseJsonlFile<unknown>(
        selected.actions!,
        (value) => {
          if (!isActionLine(value)) {
            skippedLines.actions += 1;
            return;
          }
          actionsAcc.addLine(value as ActionLine);
        },
        {
          signal: abort.signal,
          onProgress: updateProgress('actions'),
        }
      );

      const { actions, summary: actionsSummary } = actionsAcc.finish();

      const depsAcc = createDependenciesAccumulator();
      const depsParse = await parseJsonlFile<unknown>(
        selected.dependencies!,
        (value) => {
          if (!isDependenciesLine(value)) {
            skippedLines.dependencies += 1;
            return;
          }
          depsAcc.addLine(value as DependenciesLine);
        },
        {
          signal: abort.signal,
          onProgress: updateProgress('dependencies'),
        }
      );

      const dependencies = depsAcc.finish();

      const pathPrefix = getCommonPathPrefix([
        ...entry.instances.map((i) => i.filename ?? ''),
        ...dependencies.files,
      ]);

      setParseErrors({
        entrypoints: entryParse.errors,
        actions: actionsParse.errors,
        dependencies: depsParse.errors,
      });

      setData({
        actions,
        actionsSummary,
        dependencies,
        entrypointsFiles: entry.files,
        entrypointsInstances: entry.instances,
        pathPrefix,
        skippedLines,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      setFatalError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsParsing(false);
      setParseProgress(null);
      abortRef.current = null;
    }
  }, [canParse, selected]);

  const onParseClick = React.useCallback(() => {
    parse().catch(() => {});
  }, [parse]);

  const [pathPrefix, setPathPrefix] = React.useState('');

  React.useEffect(() => {
    setPathPrefix(data?.pathPrefix ?? '');
  }, [data?.pathPrefix]);

  const [actionsFilterType, setActionsFilterType] = React.useState('');
  const [actionsFilterEntrypoint, setActionsFilterEntrypoint] =
    React.useState('');
  const [actionsFailedOnly, setActionsFailedOnly] = React.useState(false);
  const [actionsLimit, setActionsLimit] = React.useState(200);
  const [selectedAction, setSelectedAction] =
    React.useState<ActionRecord | null>(null);

  const filteredActions = React.useMemo(() => {
    if (!data) return [];
    const typeQ = actionsFilterType.trim().toLowerCase();
    const entryQ = actionsFilterEntrypoint.trim().toLowerCase();

    const out: ActionRecord[] = [];
    for (const a of data.actions) {
      const entry = a.entrypointFilename ?? a.entrypointRef;
      const matches =
        (!actionsFailedOnly || a.result === 'failed') &&
        (!typeQ || a.type.toLowerCase().includes(typeQ)) &&
        (!entryQ || entry.toLowerCase().includes(entryQ));

      if (matches) {
        out.push(a);
        if (out.length >= actionsLimit) break;
      }
    }
    return out;
  }, [
    actionsFailedOnly,
    actionsFilterEntrypoint,
    actionsFilterType,
    actionsLimit,
    data,
  ]);

  const [entrypointsFilter, setEntrypointsFilter] = React.useState('');
  const [entrypointsLimit, setEntrypointsLimit] = React.useState(100);
  const [selectedEntrypointFile, setSelectedEntrypointFile] = React.useState<
    string | null
  >(null);
  const [selectedEntrypointSeqId, setSelectedEntrypointSeqId] = React.useState<
    number | null
  >(null);

  const filteredEntrypointFiles = React.useMemo(() => {
    if (!data) return [];
    const q = entrypointsFilter.trim().toLowerCase();
    const out: EntrypointFileStats[] = [];
    for (const f of data.entrypointsFiles) {
      const filename = f.filename.toLowerCase();
      if (!q || filename.includes(q)) {
        out.push(f);
        if (out.length >= entrypointsLimit) break;
      }
    }
    return out;
  }, [data, entrypointsFilter, entrypointsLimit]);

  const selectedFileInstances = React.useMemo(() => {
    if (!data || !selectedEntrypointFile) return [];
    return data.entrypointsInstances
      .filter((i) => i.filename === selectedEntrypointFile)
      .sort((a, b) => (a.generation ?? 0) - (b.generation ?? 0));
  }, [data, selectedEntrypointFile]);

  const selectedSupersedeChain = React.useMemo(() => {
    if (!data || selectedEntrypointSeqId === null) return [];
    return getSupersedeChain(
      data.entrypointsInstances,
      selectedEntrypointSeqId
    );
  }, [data, selectedEntrypointSeqId]);

  const [importQuery, setImportQuery] = React.useState('');
  const [selectedImport, setSelectedImport] = React.useState<string | null>(
    null
  );

  const matchedImports = React.useMemo(() => {
    if (!data) return [];
    const q = importQuery.trim().toLowerCase();
    if (!q) return data.dependencies.topImports;

    const out: Array<{ from: string; importersCount: number }> = [];
    for (const from of data.dependencies.importersByFrom.keys()) {
      if (from.toLowerCase().includes(q)) {
        out.push({
          from,
          importersCount:
            data.dependencies.importersByFrom.get(from)?.size ?? 0,
        });
        if (out.length >= 50) break;
      }
    }

    return out.sort((a, b) => b.importersCount - a.importersCount);
  }, [data, importQuery]);

  const selectedImporters = React.useMemo(() => {
    if (!data || !selectedImport) return [];
    const set = data.dependencies.importersByFrom.get(selectedImport);
    return Array.from(set ?? []).sort();
  }, [data, selectedImport]);

  return (
    <div>
      <p>
        This tool analyzes WyW debug logs generated by the built-in file
        reporter (<code>actions.jsonl</code>, <code>dependencies.jsonl</code>,{' '}
        <code>entrypoints.jsonl</code>).
      </p>
      <p>
        Privacy: the analysis runs fully in your browser. Files are not uploaded
        anywhere.
      </p>

      <h2>Upload logs</h2>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        style={{
          border: '1px dashed #bbb',
          borderRadius: 8,
          padding: 16,
          background: '#fafafa',
        }}
      >
        <p style={{ marginTop: 0 }}>
          Drag &amp; drop the 3 files here, or pick them using the inputs below.
        </p>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 6 }}>
            <span>Pick files</span>
            <input
              type="file"
              multiple
              disabled={isParsing}
              onChange={(e) =>
                onPickFiles(Array.from(e.currentTarget.files ?? []))
              }
            />
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span>Pick folder</span>
            <DirectoryInput disabled={isParsing} onFiles={onPickFiles} />
          </label>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <strong>Expected files:</strong> <code>actions.jsonl</code>,{' '}
        <code>dependencies.jsonl</code>, <code>entrypoints.jsonl</code>
      </div>

      {problems.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong>Upload issues:</strong>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <div
        style={{ marginTop: 12, display: 'flex', gap: 12, flexWrap: 'wrap' }}
      >
        <button
          type="button"
          disabled={!canParse || isParsing}
          onClick={onParseClick}
        >
          {isParsing ? 'Parsing…' : 'Parse logs'}
        </button>
        <button
          type="button"
          disabled={isParsing && !abortRef.current}
          onClick={reset}
        >
          Reset
        </button>
      </div>

      {parseProgress && (
        <div style={{ marginTop: 12 }}>
          <strong>Parsing:</strong>{' '}
          <code>{FILE_NAME_BY_KEY[parseProgress.file]}</code> —{' '}
          {formatBytes(parseProgress.progress.bytesRead)} /{' '}
          {formatBytes(parseProgress.progress.bytesTotal)} —{' '}
          {parseProgress.progress.lines.toLocaleString()} lines
        </div>
      )}

      {fatalError && (
        <div style={{ marginTop: 12, color: '#b00020' }}>
          <strong>Error:</strong> {fatalError}
        </div>
      )}

      {data && (
        <>
          <h2>Summary</h2>
          <ul>
            <li>
              Wall time (span):{' '}
              <strong>{formatMs(data.actionsSummary.spanMs)}</strong>
            </li>
            <li>
              Actions: <strong>{data.actionsSummary.totalActions}</strong>{' '}
              total, <strong>{data.actionsSummary.finishedActions}</strong>{' '}
              finished, <strong>{data.actionsSummary.failedActions}</strong>{' '}
              failed, <strong>{data.actionsSummary.asyncActions}</strong> async
            </li>
            <li>
              Skipped lines (shape mismatch): actions{' '}
              {data.skippedLines.actions}, dependencies{' '}
              {data.skippedLines.dependencies}, entrypoints{' '}
              {data.skippedLines.entrypoints}
            </li>
          </ul>

          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <strong>Top action types (inclusive)</strong>
              <ul>
                {data.actionsSummary.topTypesByInclusiveMs.map(([type, ms]) => (
                  <li key={type}>
                    <code>{type}</code>: {formatMs(ms)}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <strong>Top action types (exclusive)</strong>
              <ul>
                {data.actionsSummary.topTypesByExclusiveMs.map(([type, ms]) => (
                  <li key={type}>
                    <code>{type}</code>: {formatMs(ms)}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <h2>Actions</h2>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span>Filter type</span>
              <input
                value={actionsFilterType}
                onChange={(e) => setActionsFilterType(e.currentTarget.value)}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span>Filter entrypoint</span>
              <input
                value={actionsFilterEntrypoint}
                onChange={(e) =>
                  setActionsFilterEntrypoint(e.currentTarget.value)
                }
                placeholder="filename or entrypointRef"
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={actionsFailedOnly}
                onChange={(e) => setActionsFailedOnly(e.currentTarget.checked)}
              />
              failed only
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span>Row limit</span>
              <input
                type="number"
                min={50}
                max={2000}
                value={actionsLimit}
                onChange={(e) => setActionsLimit(Number(e.currentTarget.value))}
              />
            </label>
          </div>

          <p>
            Showing <strong>{filteredActions.length}</strong> actions (sorted by
            duration).
          </p>

          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th align="left">duration</th>
                  <th align="left">type</th>
                  <th align="left">result</th>
                  <th align="left">async</th>
                  <th align="left">entrypoint</th>
                  <th align="left">actionId</th>
                </tr>
              </thead>
              <tbody>
                {filteredActions.map((a) => {
                  const entry = a.entrypointFilename ?? a.entrypointRef;
                  return (
                    <tr
                      key={a.actionId}
                      style={{
                        cursor: 'pointer',
                        background:
                          selectedAction?.actionId === a.actionId
                            ? '#f2f6ff'
                            : undefined,
                      }}
                      onClick={() => setSelectedAction(a)}
                    >
                      <td>{formatMs(a.durationMs)}</td>
                      <td>
                        <code>{a.type}</code>
                      </td>
                      <td>{a.result}</td>
                      <td>{a.isAsync ? 'yes' : 'no'}</td>
                      <td>
                        <code>{trimPathPrefix(entry, pathPrefix)}</code>
                      </td>
                      <td>{a.actionId}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selectedAction && (
            <details open style={{ marginTop: 12 }}>
              <summary>
                Action details: <code>{selectedAction.type}</code> —{' '}
                {formatMs(selectedAction.durationMs)}
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(selectedAction, null, 2)}
              </pre>
            </details>
          )}

          <h2>Entrypoints (storm detector)</h2>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span>Filter filename</span>
              <input
                value={entrypointsFilter}
                onChange={(e) => setEntrypointsFilter(e.currentTarget.value)}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span>Row limit</span>
              <input
                type="number"
                min={20}
                max={500}
                value={entrypointsLimit}
                onChange={(e) =>
                  setEntrypointsLimit(Number(e.currentTarget.value))
                }
              />
            </label>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th align="left">file</th>
                  <th align="right">created</th>
                  <th align="right">superseded</th>
                  <th align="right">only min</th>
                  <th align="right">only max</th>
                  <th align="right">only growth</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntrypointFiles.map((f) => {
                  const growth =
                    f.onlyMin !== null && f.onlyMax !== null
                      ? f.onlyMax - f.onlyMin
                      : 0;
                  return (
                    <tr
                      key={f.filename}
                      style={{
                        cursor: 'pointer',
                        background:
                          selectedEntrypointFile === f.filename
                            ? '#f2f6ff'
                            : undefined,
                      }}
                      onClick={() => {
                        setSelectedEntrypointFile(f.filename);
                        setSelectedEntrypointSeqId(null);
                      }}
                    >
                      <td>
                        <code>{trimPathPrefix(f.filename, pathPrefix)}</code>
                      </td>
                      <td align="right">{f.createdCount}</td>
                      <td align="right">{f.supersededCount}</td>
                      <td align="right">{f.onlyMin ?? '–'}</td>
                      <td align="right">{f.onlyMax ?? '–'}</td>
                      <td align="right">{growth}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selectedEntrypointFile && (
            <details open style={{ marginTop: 12 }}>
              <summary>
                Entrypoint instances for{' '}
                <code>
                  {trimPathPrefix(selectedEntrypointFile, pathPrefix)}
                </code>
              </summary>

              <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span>Trim common path prefix</span>
                  <input
                    value={pathPrefix}
                    onChange={(e) => setPathPrefix(e.currentTarget.value)}
                  />
                </label>
              </div>

              <div style={{ overflowX: 'auto', marginTop: 8 }}>
                <table>
                  <thead>
                    <tr>
                      <th align="left">seqId</th>
                      <th align="left">ref</th>
                      <th align="right">gen</th>
                      <th align="right">only</th>
                      <th align="left">superseded with</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedFileInstances.map((i) => (
                      <tr
                        key={i.seqId}
                        style={{
                          cursor: 'pointer',
                          background:
                            selectedEntrypointSeqId === i.seqId
                              ? '#f2f6ff'
                              : undefined,
                        }}
                        onClick={() => setSelectedEntrypointSeqId(i.seqId)}
                      >
                        <td>{i.seqId}</td>
                        <td>
                          <code>{i.ref ?? '–'}</code>
                        </td>
                        <td align="right">{i.generation ?? '–'}</td>
                        <td align="right">{i.onlyLen ?? '–'}</td>
                        <td>
                          {i.supersededWith !== undefined
                            ? i.supersededWith
                            : '–'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selectedSupersedeChain.length > 0 && (
                <details open style={{ marginTop: 12 }}>
                  <summary>Supersede chain (seqId → seqId)</summary>
                  <ol>
                    {selectedSupersedeChain.map((i) => (
                      <li key={i.seqId}>
                        <code>
                          {i.seqId}
                          {i.ref ? ` (${i.ref})` : ''}
                          {i.supersededWith !== undefined
                            ? ` → ${i.supersededWith}`
                            : ''}
                        </code>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </details>
          )}

          <h2>Dependencies</h2>

          <p>
            <strong>{data.dependencies.filesCount}</strong> files,{' '}
            <strong>{data.dependencies.importsCount}</strong> import edges.
          </p>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span>Find import specifier</span>
              <input
                value={importQuery}
                onChange={(e) => setImportQuery(e.currentTarget.value)}
                placeholder="e.g. @radix-ui/react-dialog"
              />
            </label>
          </div>

          <div
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}
          >
            <div>
              <strong>Top imports</strong>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th align="left">from</th>
                      <th align="right">count</th>
                      <th align="right">importers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matchedImports.map((row) => {
                      if ('count' in row) {
                        return (
                          <tr
                            key={row.from}
                            style={{
                              cursor: 'pointer',
                              background:
                                selectedImport === row.from
                                  ? '#f2f6ff'
                                  : undefined,
                            }}
                            onClick={() => setSelectedImport(row.from)}
                          >
                            <td>
                              <code>{row.from}</code>
                            </td>
                            <td align="right">{row.count}</td>
                            <td align="right">{row.importers.length}</td>
                          </tr>
                        );
                      }

                      return (
                        <tr
                          key={row.from}
                          style={{
                            cursor: 'pointer',
                            background:
                              selectedImport === row.from
                                ? '#f2f6ff'
                                : undefined,
                          }}
                          onClick={() => setSelectedImport(row.from)}
                        >
                          <td>
                            <code>{row.from}</code>
                          </td>
                          <td align="right">–</td>
                          <td align="right">{row.importersCount}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <strong>Top packages</strong>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th align="left">package</th>
                      <th align="right">count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.dependencies.topPackages.map((p) => (
                      <tr key={p.name}>
                        <td>
                          <code>{p.name}</code>
                        </td>
                        <td align="right">{p.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {selectedImport && (
            <details open style={{ marginTop: 12 }}>
              <summary>
                Importers of <code>{selectedImport}</code>
              </summary>
              <ul>
                {selectedImporters.slice(0, 200).map((f) => (
                  <li key={f}>
                    <code>{trimPathPrefix(f, pathPrefix)}</code>
                  </li>
                ))}
              </ul>
              {selectedImporters.length > 200 && (
                <p>Showing first 200 importers.</p>
              )}
            </details>
          )}

          <h2>Parsing warnings</h2>

          {parseErrors && (
            <div style={{ display: 'grid', gap: 12 }}>
              {REQUIRED_FILENAMES.map((k) => {
                const errors = parseErrors[k];
                if (!errors || errors.length === 0) return null;
                return (
                  <details key={k}>
                    <summary>
                      <code>{FILE_NAME_BY_KEY[k]}</code>: {errors.length} JSON
                      parse errors
                    </summary>
                    <ul>
                      {errors.map((e) => (
                        <li key={`${e.lineNumber}:${e.message}`}>
                          line {e.lineNumber}: {e.message} —{' '}
                          <code>{e.linePreview}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
            </div>
          )}

          <h2>How to generate these logs</h2>
          <p>
            WyW bundler integrations support a <code>debug</code> option that
            writes these files to disk. Example (Vite):
          </p>
          <pre>
            <code>{`// vite.config.ts
import wyw from '@wyw-in-js/vite';

export default {
  plugins: [
    wyw({
      debug: { dir: 'wyw-debug', print: true },
    }),
  ],
};`}</code>
          </pre>
          <p>
            The directory will contain <code>actions.jsonl</code>,{' '}
            <code>dependencies.jsonl</code> and <code>entrypoints.jsonl</code>.
          </p>

          <h2>Notes</h2>
          <ul>
            <li>
              <code>entrypointRef</code> in <code>actions.jsonl</code> is a
              stable internal reference (<code>idx#generation</code>), not a
              file path. The analyzer resolves it to a filename using{' '}
              <code>entrypoints.jsonl</code>.
            </li>
            <li>
              If you see a lot of “superseded” entrypoints for one file and the{' '}
              <code>only</code> set keeps growing, it usually indicates an
              invalidation storm.
            </li>
          </ul>
        </>
      )}
    </div>
  );
}
