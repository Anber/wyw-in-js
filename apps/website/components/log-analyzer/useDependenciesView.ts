import * as React from 'react';

import type { ParsedData } from './state';

export function useDependenciesView(params: { data: ParsedData | null }) {
  const { data } = params;

  const [importQuery, setImportQuery] = React.useState('');
  const [selectedImport, setSelectedImport] = React.useState<string | null>(
    null
  );

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

  const reset = React.useCallback(() => {
    setImportQuery('');
    setSelectedImport(null);
  }, []);

  return {
    importQuery,
    setImportQuery,
    selectedImport,
    setSelectedImport,
    matchedImports,
    selectedImporters,
    reset,
  };
}

export type DependenciesViewState = ReturnType<typeof useDependenciesView>;
