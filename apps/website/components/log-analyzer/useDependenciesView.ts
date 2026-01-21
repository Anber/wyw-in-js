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

    const limit = 50;
    const out: Array<{ count: number; from: string; importersCount: number }> =
      [];
    let minIndex = -1;
    let minCount = Infinity;
    for (const from of data.dependencies.importersByFrom.keys()) {
      if (from.toLowerCase().includes(q)) {
        const count = data.dependencies.importCountByFrom.get(from) ?? 0;
        const importersCount =
          data.dependencies.importersByFrom.get(from)?.size ?? 0;

        const row = { count, from, importersCount };

        if (out.length < limit) {
          out.push(row);
          if (count < minCount) {
            minCount = count;
            minIndex = out.length - 1;
          }
        } else if (count > minCount) {
          out[minIndex] = row;
          minCount = Infinity;
          minIndex = 0;
          for (let i = 0; i < out.length; i += 1) {
            if (out[i].count < minCount) {
              minCount = out[i].count;
              minIndex = i;
            }
          }
        }
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
