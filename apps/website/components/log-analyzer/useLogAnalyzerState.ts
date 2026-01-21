import * as React from 'react';

import { useActionsView } from './useActionsView';
import { useClipboardToast } from './useClipboardToast';
import { useDependenciesView } from './useDependenciesView';
import { useEntrypointsView } from './useEntrypointsView';
import { useParseWywLogs } from './useParseWywLogs';
import { usePathDisplay } from './usePathDisplay';
import { useUploadFiles } from './useUploadFiles';
import type { TabId } from './state';

export function useLogAnalyzerState() {
  const upload = useUploadFiles();
  const parse = useParseWywLogs();
  const clipboard = useClipboardToast();

  const [activeTab, setActiveTab] = React.useState<TabId>('overview');

  const pathDisplay = usePathDisplay(parse.data?.pathPrefix ?? '');

  const actions = useActionsView({
    data: parse.data,
    pathPrefix: pathDisplay.pathPrefix,
  });

  const entrypoints = useEntrypointsView({
    data: parse.data,
    pathPrefix: pathDisplay.pathPrefix,
  });

  const dependencies = useDependenciesView({
    data: parse.data,
  });

  const {
    reset: resetActionsView,
    setFilterEntrypoint,
    setFilterImportFrom,
    setSelectedAction,
  } = actions;

  const { reset: resetEntrypointsView, selectFile } = entrypoints;

  const { reset: resetDependenciesView } = dependencies;

  const { reset: resetClipboard } = clipboard;

  const { displayPath, reset: resetPathDisplay } = pathDisplay;

  const resetViews = React.useCallback(() => {
    setActiveTab('overview');
    resetActionsView();
    resetEntrypointsView();
    resetDependenciesView();
    resetClipboard();
    resetPathDisplay();
  }, [
    resetActionsView,
    resetClipboard,
    resetDependenciesView,
    resetEntrypointsView,
    resetPathDisplay,
  ]);

  const onPickFiles = React.useCallback(
    (files: File[]) => {
      upload.onPickFiles(files);
      parse.reset();
      resetViews();
    },
    [parse, resetViews, upload]
  );

  const onDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (parse.isParsing) return;
      onPickFiles(Array.from(e.dataTransfer.files ?? []));
    },
    [onPickFiles, parse.isParsing]
  );

  const parseLogs = React.useCallback(async () => {
    if (!upload.canParse || parse.isParsing) return;
    resetViews();
    await parse.parse(upload.selected);
  }, [parse, resetViews, upload.canParse, upload.selected]);

  const resetAll = React.useCallback(() => {
    upload.reset();
    parse.reset();
    resetViews();
  }, [parse, resetViews, upload]);

  const openActionsTabForEntrypoint = React.useCallback(
    (entrypoint: string) => {
      setActiveTab('actions');
      setSelectedAction(null);
      setFilterImportFrom('');
      setFilterEntrypoint(displayPath(entrypoint));
    },
    [displayPath, setFilterEntrypoint, setFilterImportFrom, setSelectedAction]
  );

  const openActionsTabForImport = React.useCallback(
    (from: string) => {
      setActiveTab('actions');
      setSelectedAction(null);
      setFilterEntrypoint('');
      setFilterImportFrom(displayPath(from));
    },
    [displayPath, setFilterEntrypoint, setFilterImportFrom, setSelectedAction]
  );

  const openEntrypointsTabForFile = React.useCallback(
    (filename: string) => {
      setActiveTab('entrypoints');
      selectFile(filename);
    },
    [selectFile]
  );

  return {
    upload: {
      ...upload,
      onPickFiles,
      onDrop,
    },
    parse,
    clipboard,
    pathDisplay,
    ui: {
      activeTab,
      setActiveTab,
    },
    actions,
    entrypoints,
    dependencies,
    nav: {
      openActionsTabForEntrypoint,
      openActionsTabForImport,
      openEntrypointsTabForFile,
    },
    parseLogs,
    resetAll,
  };
}

export type LogAnalyzerState = ReturnType<typeof useLogAnalyzerState>;
