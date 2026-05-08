import * as React from 'react';

import type { ParsedData } from './state';
import type { EvalFileRecord, EvalFileValueStatus } from './types';

export function useEvalFilesView(params: { data: ParsedData | null }) {
  const { data } = params;

  const [query, setQuery] = React.useState('');
  const [kind, setKind] = React.useState<'all' | EvalFileRecord['payloadKind']>(
    'all'
  );
  const [status, setStatus] = React.useState<'all' | EvalFileValueStatus>(
    'all'
  );
  const [selected, setSelected] = React.useState<EvalFileRecord | null>(null);

  const matched = React.useMemo(() => {
    const records = data?.evalFiles?.records ?? [];
    const q = query.trim().toLowerCase();

    return records
      .filter((record) => {
        if (kind !== 'all' && record.payloadKind !== kind) return false;
        if (status !== 'all' && record.valueStatus !== status) return false;
        if (!q) return true;
        return (
          record.id.toLowerCase().includes(q) ||
          (record.importer ?? '').toLowerCase().includes(q) ||
          (record.request ?? '').toLowerCase().includes(q)
        );
      })
      .slice(0, 500);
  }, [data, kind, query, status]);

  const reset = React.useCallback(() => {
    setQuery('');
    setKind('all');
    setStatus('all');
    setSelected(null);
  }, []);

  React.useEffect(() => {
    if (!selected) return;
    if (!matched.some((record) => record.lineNumber === selected.lineNumber)) {
      setSelected(null);
    }
  }, [matched, selected]);

  return {
    kind,
    matched,
    query,
    selected,
    setKind,
    setQuery,
    setSelected,
    setStatus,
    status,
    reset,
  };
}

export type EvalFilesViewState = ReturnType<typeof useEvalFilesView>;
