import * as React from 'react';

import { REQUIRED_FILENAMES } from './constants';
import {
  createActionsAccumulator,
  createDependenciesAccumulator,
  createEntrypointsAccumulator,
  getCommonPathPrefix,
  getSupersedeChain,
  trimPathPrefix,
} from './analyze';
import { detectRequiredFiles } from './files';
import { isActionLine, isDependenciesLine, isEntrypointLine } from './guards';
import { parseJsonlFile } from './jsonl';
import type { JsonlProgress } from './jsonl';
import type {
  ActionLine,
  ActionRecord,
  DependenciesLine,
  EntrypointFileStats,
  EntrypointLine,
} from './types';
import type {
  ParseErrors,
  ParseProgress,
  ParsedData,
  RequiredFiles,
  RequiredFileKey,
  TabId,
} from './state';
import { isAbsolutePathLike, writeClipboardText } from './utils';

export type LogAnalyzerState = ReturnType<typeof useLogAnalyzerState>;

export function useLogAnalyzerState() {
  const [selected, setSelected] = React.useState<RequiredFiles>({});
  const [problems, setProblems] = React.useState<string[]>([]);
  const [inputsKey, setInputsKey] = React.useState(0);

  const [parseProgress, setParseProgress] =
    React.useState<ParseProgress | null>(null);

  const [isParsing, setIsParsing] = React.useState(false);
  const [parseErrors, setParseErrors] = React.useState<ParseErrors | null>(
    null
  );
  const [data, setData] = React.useState<ParsedData | null>(null);
  const [fatalError, setFatalError] = React.useState<string | null>(null);
  const [copyMessage, setCopyMessage] = React.useState<string | null>(null);

  const [activeTab, setActiveTab] = React.useState<TabId>('overview');

  React.useEffect(() => {
    if (data) setActiveTab('overview');
  }, [data]);

  const abortRef = React.useRef<AbortController | null>(null);
  const lastProgressUpdateRef = React.useRef(0);
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;

      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const [pathPrefix, setPathPrefix] = React.useState('');

  React.useEffect(() => {
    setPathPrefix(data?.pathPrefix ?? '');
  }, [data?.pathPrefix]);

  const [actionsFilterType, setActionsFilterType] = React.useState('');
  const [actionsFilterEntrypoint, setActionsFilterEntrypoint] =
    React.useState('');
  const [actionsFilterImportFrom, setActionsFilterImportFrom] =
    React.useState('');
  const [actionsFailedOnly, setActionsFailedOnly] = React.useState(false);
  const [actionsLimit, setActionsLimit] = React.useState(200);
  const [selectedAction, setSelectedAction] =
    React.useState<ActionRecord | null>(null);

  const [entrypointsFilter, setEntrypointsFilter] = React.useState('');
  const [entrypointsLimit, setEntrypointsLimit] = React.useState(100);
  const [selectedEntrypointFile, setSelectedEntrypointFile] = React.useState<
    string | null
  >(null);
  const [selectedEntrypointSeqId, setSelectedEntrypointSeqId] = React.useState<
    number | null
  >(null);

  const [importQuery, setImportQuery] = React.useState('');
  const [selectedImport, setSelectedImport] = React.useState<string | null>(
    null
  );

  const reset = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    setInputsKey((prev) => prev + 1);
    setActiveTab('overview');
    setSelected({});
    setProblems([]);
    setParseProgress(null);
    setIsParsing(false);
    setParseErrors(null);
    setData(null);
    setFatalError(null);
    setCopyMessage(null);

    setPathPrefix('');

    setActionsFilterType('');
    setActionsFilterEntrypoint('');
    setActionsFilterImportFrom('');
    setActionsFailedOnly(false);
    setActionsLimit(200);
    setSelectedAction(null);

    setEntrypointsFilter('');
    setEntrypointsLimit(100);
    setSelectedEntrypointFile(null);
    setSelectedEntrypointSeqId(null);

    setImportQuery('');
    setSelectedImport(null);
  }, []);

  const showCopyMessage = React.useCallback((message: string) => {
    setCopyMessage(message);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopyMessage(null);
      copyTimerRef.current = null;
    }, 1400);
  }, []);

  const copyText = React.useCallback(
    async (text: string, successMessage: string) => {
      const ok = await writeClipboardText(text);
      showCopyMessage(ok ? successMessage : 'Copy failed');
    },
    [showCopyMessage]
  );

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

    const skippedLines: Record<RequiredFileKey, number> = {
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

      const allPaths = [
        ...entry.instances.map((i) => i.filename ?? ''),
        ...dependencies.files,
      ].filter(Boolean);

      const absolutePaths = allPaths.filter(isAbsolutePathLike);

      const nextPathPrefix = getCommonPathPrefix(
        absolutePaths.length >= 2 ? absolutePaths : allPaths
      );

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
        pathPrefix: nextPathPrefix,
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

  const resetPathPrefixToAuto = React.useCallback(() => {
    setPathPrefix(data?.pathPrefix ?? '');
  }, [data?.pathPrefix]);

  const clearPathPrefix = React.useCallback(() => {
    setPathPrefix('');
  }, []);

  const openActionsTabForEntrypoint = React.useCallback(
    (entrypoint: string) => {
      setActiveTab('actions');
      setSelectedAction(null);
      setActionsFilterImportFrom('');
      setActionsFilterEntrypoint(trimPathPrefix(entrypoint, pathPrefix));
    },
    [pathPrefix]
  );

  const openActionsTabForImport = React.useCallback(
    (from: string) => {
      setActiveTab('actions');
      setSelectedAction(null);
      setActionsFilterEntrypoint('');
      setActionsFilterImportFrom(trimPathPrefix(from, pathPrefix));
    },
    [pathPrefix]
  );

  const openEntrypointsTabForFile = React.useCallback(
    (filename: string) => {
      setActiveTab('entrypoints');
      setEntrypointsFilter(trimPathPrefix(filename, pathPrefix));
      setSelectedEntrypointFile(filename);
      setSelectedEntrypointSeqId(null);
    },
    [pathPrefix]
  );

  const filteredActions = React.useMemo(() => {
    if (!data) return [];
    const typeQ = actionsFilterType.trim().toLowerCase();
    const entryQ = actionsFilterEntrypoint.trim().toLowerCase();
    const importFrom = actionsFilterImportFrom.trim();

    let importersForFilter: Set<string> | null = null;

    if (importFrom) {
      const normalized = importFrom.replace(/\\\\/g, '/');
      const withPrefix = pathPrefix ? `${pathPrefix}${normalized}` : normalized;

      const candidates = [
        importFrom,
        normalized,
        withPrefix,
        normalized.startsWith('/') ? normalized : '',
      ].filter(Boolean);

      for (const candidate of candidates) {
        const set = data.dependencies.importersByFrom.get(candidate);
        if (set) {
          importersForFilter = set;
          break;
        }
      }

      if (!importersForFilter) {
        const union = new Set<string>();
        for (const [from, importers] of data.dependencies.importersByFrom) {
          if (trimPathPrefix(from, pathPrefix) === importFrom) {
            for (const importer of importers) union.add(importer);
          }
        }
        importersForFilter = union.size ? union : null;
      }
    }

    const out: ActionRecord[] = [];
    for (const a of data.actions) {
      const entry = a.entrypointFilename ?? a.entrypointRef;
      const matchesImport =
        !importFrom ||
        (!!a.entrypointFilename &&
          !!importersForFilter?.has(a.entrypointFilename));
      const matches =
        matchesImport &&
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
    actionsFilterImportFrom,
    actionsLimit,
    data,
    pathPrefix,
  ]);

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

  const selectedEntrypointInstance = React.useMemo(() => {
    if (!data || selectedEntrypointSeqId === null) return null;
    return (
      data.entrypointsInstances.find(
        (i) => i.seqId === selectedEntrypointSeqId
      ) ?? null
    );
  }, [data, selectedEntrypointSeqId]);

  const selectedSupersedeChain = React.useMemo(() => {
    if (!data || selectedEntrypointSeqId === null) return [];
    return getSupersedeChain(
      data.entrypointsInstances,
      selectedEntrypointSeqId
    );
  }, [data, selectedEntrypointSeqId]);

  const matchedImports = React.useMemo(() => {
    if (!data) return [];
    const q = importQuery.trim().toLowerCase();
    if (!q) {
      return data.dependencies.topImports.map((row) => ({
        from: row.from,
        count: row.count,
        importersCount: row.importers.length,
      }));
    }

    const out: Array<{ count: number; from: string; importersCount: number }> =
      [];
    for (const from of data.dependencies.importersByFrom.keys()) {
      if (from.toLowerCase().includes(q)) {
        out.push({
          count: data.dependencies.importCountByFrom.get(from) ?? 0,
          from,
          importersCount:
            data.dependencies.importersByFrom.get(from)?.size ?? 0,
        });
        if (out.length >= 50) break;
      }
    }

    return out.sort((a, b) => b.count - a.count);
  }, [data, importQuery]);

  const selectedImporters = React.useMemo(() => {
    if (!data || !selectedImport) return [];
    const set = data.dependencies.importersByFrom.get(selectedImport);
    return Array.from(set ?? []).sort();
  }, [data, selectedImport]);

  return {
    selected,
    problems,
    inputsKey,
    parseProgress,
    isParsing,
    parseErrors,
    data,
    fatalError,
    copyMessage,
    activeTab,
    pathPrefix,

    canParse,

    setActiveTab,
    setPathPrefix,
    resetPathPrefixToAuto,
    clearPathPrefix,

    reset,
    onPickFiles,
    onDrop,
    onParseClick,

    copyText,

    actionsFilterType,
    setActionsFilterType,
    actionsFilterEntrypoint,
    setActionsFilterEntrypoint,
    actionsFilterImportFrom,
    setActionsFilterImportFrom,
    actionsFailedOnly,
    setActionsFailedOnly,
    actionsLimit,
    setActionsLimit,
    selectedAction,
    setSelectedAction,
    filteredActions,
    openActionsTabForEntrypoint,
    openActionsTabForImport,
    openEntrypointsTabForFile,

    entrypointsFilter,
    setEntrypointsFilter,
    entrypointsLimit,
    setEntrypointsLimit,
    selectedEntrypointFile,
    setSelectedEntrypointFile,
    selectedEntrypointSeqId,
    setSelectedEntrypointSeqId,
    filteredEntrypointFiles,
    selectedFileInstances,
    selectedEntrypointInstance,
    selectedSupersedeChain,

    importQuery,
    setImportQuery,
    selectedImport,
    setSelectedImport,
    matchedImports,
    selectedImporters,
  };
}
