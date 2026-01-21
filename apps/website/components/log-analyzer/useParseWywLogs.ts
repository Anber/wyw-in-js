import * as React from 'react';

import {
  createActionsAccumulator,
  createDependenciesAccumulator,
  createEntrypointsAccumulator,
  getCommonPathPrefix,
} from './analyze';
import { isActionLine, isDependenciesLine, isEntrypointLine } from './guards';
import { parseJsonlFile } from './jsonl';
import type { JsonlProgress } from './jsonl';
import type { ActionLine, DependenciesLine, EntrypointLine } from './types';
import type {
  ParseErrors,
  ParseProgress,
  ParsedData,
  RequiredFiles,
  RequiredFileKey,
} from './state';
import { isAbsolutePathLike } from './utils';

export function useParseWywLogs() {
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

  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const reset = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    setParseProgress(null);
    setIsParsing(false);
    setParseErrors(null);
    setData(null);
    setFatalError(null);
  }, []);

  const parse = React.useCallback(async (selected: RequiredFiles) => {
    if (!selected.actions || !selected.dependencies || !selected.entrypoints) {
      return;
    }

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setIsParsing(true);
    setParseErrors(null);
    setData(null);
    setFatalError(null);

    const skippedLines: Record<RequiredFileKey, number> = {
      actions: 0,
      dependencies: 0,
      entrypoints: 0,
    };

    const updateProgress = (file: RequiredFileKey) => (p: JsonlProgress) => {
      const now = performance.now();
      if (now - lastProgressUpdateRef.current < 120) return;
      lastProgressUpdateRef.current = now;
      setParseProgress({ file, progress: p });
    };

    try {
      const entryAcc = createEntrypointsAccumulator();
      const entryParse = await parseJsonlFile<unknown>(
        selected.entrypoints,
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
        selected.actions,
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
        selected.dependencies,
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
  }, []);

  return {
    parseProgress,
    isParsing,
    parseErrors,
    data,
    fatalError,
    parse,
    reset,
  };
}

export type ParseWywLogsState = ReturnType<typeof useParseWywLogs>;
