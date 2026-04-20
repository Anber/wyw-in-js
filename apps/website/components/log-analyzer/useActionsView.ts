import * as React from 'react';

import { trimPathPrefix } from './analyze';
import type { ActionRecord } from './types';
import type { ParsedData } from './state';

function resolveImportersForFilter(
  data: ParsedData,
  input: string,
  pathPrefix: string
) {
  const normalized = input.replace(/\\\\/g, '/');
  const withPrefix = pathPrefix ? `${pathPrefix}${normalized}` : normalized;

  const candidates = [
    input,
    normalized,
    withPrefix,
    normalized.startsWith('/') ? normalized : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const set = data.dependencies.importersByFrom.get(candidate);
    if (set) return set;
  }

  const union = new Set<string>();
  for (const [from, importers] of data.dependencies.importersByFrom) {
    if (trimPathPrefix(from, pathPrefix) === input) {
      for (const importer of importers) union.add(importer);
    }
  }
  return union.size ? union : null;
}

export function useActionsView(params: {
  data: ParsedData | null;
  pathPrefix: string;
}) {
  const { data, pathPrefix } = params;

  const [filterType, setFilterType] = React.useState('');
  const [filterEntrypoint, setFilterEntrypoint] = React.useState('');
  const [filterImportFrom, setFilterImportFrom] = React.useState('');
  const [failedOnly, setFailedOnly] = React.useState(false);
  const [limit, setLimit] = React.useState(200);
  const [selectedAction, setSelectedAction] =
    React.useState<ActionRecord | null>(null);

  const rows = React.useMemo(() => {
    if (!data) return [];
    const typeQ = filterType.trim().toLowerCase();
    const entryQ = filterEntrypoint.trim().toLowerCase();
    const importFrom = filterImportFrom.trim();

    const importersForFilter =
      importFrom && data
        ? resolveImportersForFilter(data, importFrom, pathPrefix)
        : null;

    const out: ActionRecord[] = [];
    for (const a of data.actions) {
      const entry = a.entrypointFilename ?? a.entrypointRef;
      const matchesImport =
        !importFrom ||
        (!!a.entrypointFilename &&
          !!importersForFilter?.has(a.entrypointFilename));
      const matches =
        matchesImport &&
        (!failedOnly || a.result === 'failed') &&
        (!typeQ || a.type.toLowerCase().includes(typeQ)) &&
        (!entryQ || entry.toLowerCase().includes(entryQ));

      if (matches) {
        out.push(a);
        if (out.length >= limit) break;
      }
    }
    return out;
  }, [
    data,
    failedOnly,
    filterEntrypoint,
    filterImportFrom,
    filterType,
    limit,
    pathPrefix,
  ]);

  const reset = React.useCallback(() => {
    setFilterType('');
    setFilterEntrypoint('');
    setFilterImportFrom('');
    setFailedOnly(false);
    setLimit(200);
    setSelectedAction(null);
  }, []);

  return {
    filterType,
    setFilterType,
    filterEntrypoint,
    setFilterEntrypoint,
    filterImportFrom,
    setFilterImportFrom,
    failedOnly,
    setFailedOnly,
    limit,
    setLimit,
    selectedAction,
    setSelectedAction,
    rows,
    reset,
  };
}

export type ActionsViewState = ReturnType<typeof useActionsView>;
