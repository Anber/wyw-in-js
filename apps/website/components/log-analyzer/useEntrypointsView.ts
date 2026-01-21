import * as React from 'react';

import { getSupersedeChain, trimPathPrefix } from './analyze';
import type { ParsedData } from './state';
import type { EntrypointFileStats } from './types';

export function useEntrypointsView(params: {
  data: ParsedData | null;
  pathPrefix: string;
}) {
  const { data, pathPrefix } = params;

  const [filterFilename, setFilterFilename] = React.useState('');
  const [limit, setLimit] = React.useState(100);
  const [selectedFile, setSelectedFile] = React.useState<string | null>(null);
  const [selectedSeqId, setSelectedSeqId] = React.useState<number | null>(null);

  const filteredFiles = React.useMemo(() => {
    if (!data) return [];
    const q = filterFilename.trim().toLowerCase();
    const out: EntrypointFileStats[] = [];
    for (const f of data.entrypointsFiles) {
      const filename = f.filename.toLowerCase();
      if (!q || filename.includes(q)) {
        out.push(f);
        if (out.length >= limit) break;
      }
    }
    return out;
  }, [data, filterFilename, limit]);

  const selectedFileInstances = React.useMemo(() => {
    if (!data || !selectedFile) return [];
    return data.entrypointsInstances
      .filter((i) => i.filename === selectedFile)
      .sort((a, b) => (a.generation ?? 0) - (b.generation ?? 0));
  }, [data, selectedFile]);

  const selectedInstance = React.useMemo(() => {
    if (!data || selectedSeqId === null) return null;
    return (
      data.entrypointsInstances.find((i) => i.seqId === selectedSeqId) ?? null
    );
  }, [data, selectedSeqId]);

  const selectedSupersedeChain = React.useMemo(() => {
    if (!data || selectedSeqId === null) return [];
    return getSupersedeChain(data.entrypointsInstances, selectedSeqId);
  }, [data, selectedSeqId]);

  const reset = React.useCallback(() => {
    setFilterFilename('');
    setLimit(100);
    setSelectedFile(null);
    setSelectedSeqId(null);
  }, []);

  const selectFile = React.useCallback(
    (filename: string, options?: { setFilter?: boolean }) => {
      if (options?.setFilter) {
        setFilterFilename(trimPathPrefix(filename, pathPrefix));
      }
      setSelectedFile(filename);
      setSelectedSeqId(null);
    },
    [pathPrefix]
  );

  const selectInstance = React.useCallback((seqId: number) => {
    setSelectedSeqId(seqId);
  }, []);

  return {
    filterFilename,
    setFilterFilename,
    limit,
    setLimit,
    selectedFile,
    setSelectedFile,
    selectedSeqId,
    setSelectedSeqId,
    filteredFiles,
    selectedFileInstances,
    selectedInstance,
    selectedSupersedeChain,
    selectFile,
    selectInstance,
    reset,
  };
}

export type EntrypointsViewState = ReturnType<typeof useEntrypointsView>;
