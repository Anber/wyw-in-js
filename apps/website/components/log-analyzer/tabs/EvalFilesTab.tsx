import * as React from 'react';

import styles from '../LogAnalyzer.module.css';

import type { ParsedData } from '../state';
import type { ClipboardToastState } from '../useClipboardToast';
import type { EvalFilesViewState } from '../useEvalFilesView';
import type { PathDisplayState } from '../usePathDisplay';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { TruncateCell } from '../ui/TruncateCell';
import { cx } from '../utils';

const decodeBase64Utf8 = (value: string) => {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const decodeJsonBase64 = (value: string | null) => {
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(decodeBase64Utf8(value)), null, 2);
  } catch {
    return decodeBase64Utf8(value);
  }
};

type EvalFilesTabProps = {
  clipboard: ClipboardToastState;
  data: ParsedData;
  pathDisplay: PathDisplayState;
  view: EvalFilesViewState;
};

export function EvalFilesTab({
  clipboard,
  data,
  pathDisplay,
  view,
}: EvalFilesTabProps) {
  const { evalFiles } = data;
  const {
    kind,
    matched,
    query,
    selected,
    setKind,
    setQuery,
    setSelected,
    setStatus,
    status,
  } = view;

  const decoded = React.useMemo(() => {
    if (!selected) return null;
    return {
      code: selected.contentBase64
        ? decodeBase64Utf8(selected.contentBase64)
        : '',
      values: decodeJsonBase64(selected.valuesBase64),
    };
  }, [selected]);

  if (!evalFiles) {
    return null;
  }

  return (
    <div className={styles.stackLg}>
      <div className={styles.metricsGrid}>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Eval payloads
          </div>
          <div className="nx-mt-1 nx-text-2xl nx-font-semibold">
            {evalFiles.summary.totalPayloads.toLocaleString()}
          </div>
        </div>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Unique files
          </div>
          <div className="nx-mt-1 nx-text-2xl nx-font-semibold">
            {evalFiles.summary.uniqueFiles.toLocaleString()}
          </div>
        </div>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Code payloads
          </div>
          <div className="nx-mt-1 nx-text-2xl nx-font-semibold">
            {evalFiles.summary.codePayloads.toLocaleString()}
          </div>
        </div>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Stringified values
          </div>
          <div className="nx-mt-1 nx-text-2xl nx-font-semibold">
            {evalFiles.summary.withStringifiedValues.toLocaleString()}
          </div>
        </div>
      </div>

      <div className={styles.inlineFieldRow}>
        <div className={styles.fieldFlex}>
          <Field label="Find file, importer, or request">
            <input
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="e.g. theme.ts"
              className={styles.fieldInput}
            />
          </Field>
        </div>
        <Field label="Kind">
          <select
            value={kind}
            onChange={(e) => setKind(e.currentTarget.value as typeof kind)}
            className={styles.fieldInput}
          >
            <option value="all">All</option>
            <option value="code">Code</option>
            <option value="serialized-exports">Serialized exports</option>
          </select>
        </Field>
        <Field label="Value status">
          <select
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value as typeof status)}
            className={styles.fieldInput}
          >
            <option value="all">All</option>
            <option value="serialized">Serialized</option>
            <option value="stringified">Stringified</option>
            <option value="mixed">Mixed</option>
            <option value="none">None</option>
          </select>
        </Field>
      </div>

      <div className={styles.twoColGrid}>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 dark:nx-border-neutral-800">
          <div className="nx-border-b nx-border-neutral-200 nx-px-3 nx-py-2 nx-text-sm nx-font-semibold dark:nx-border-neutral-800">
            Payloads
          </div>
          <div className="nx-max-h-[560px] nx-overflow-auto">
            <table className={cx(styles.table, 'nx-w-full nx-text-sm')}>
              <colgroup>
                <col style={{ width: 70 }} />
                <col />
                <col style={{ width: 130 }} />
                <col style={{ width: 110 }} />
              </colgroup>
              <thead className="nx-bg-neutral-50 dark:nx-bg-neutral-950">
                <tr>
                  <th className="nx-px-3 nx-py-2 nx-text-right">eval</th>
                  <th className="nx-px-3 nx-py-2 nx-text-left">file</th>
                  <th className="nx-px-3 nx-py-2 nx-text-left">kind</th>
                  <th className="nx-px-3 nx-py-2 nx-text-left">values</th>
                </tr>
              </thead>
              <tbody>
                {matched.map((record) => {
                  const isSelected = selected?.lineNumber === record.lineNumber;
                  return (
                    <tr
                      key={record.lineNumber}
                      className={cx(
                        'nx-cursor-pointer nx-border-t nx-border-neutral-200 hover:nx-bg-neutral-50 dark:nx-border-neutral-800 dark:hover:nx-bg-neutral-800',
                        isSelected && 'nx-bg-neutral-100 dark:nx-bg-neutral-800'
                      )}
                      onClick={() => setSelected(record)}
                    >
                      <td className="nx-px-3 nx-py-2 nx-text-right">
                        {record.evalSeq}
                      </td>
                      <td className="nx-px-3 nx-py-2">
                        <TruncateCell
                          value={pathDisplay.displayPath(record.id)}
                          title={pathDisplay.displayPath(record.id)}
                          startEllipsis
                        />
                      </td>
                      <td className="nx-px-3 nx-py-2">{record.payloadKind}</td>
                      <td className="nx-px-3 nx-py-2">{record.valueStatus}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {matched.length === 500 && (
            <div className="nx-border-t nx-border-neutral-200 nx-px-3 nx-py-2 nx-text-xs nx-text-neutral-600 dark:nx-border-neutral-800 dark:nx-text-neutral-400">
              Showing first 500 matches. Narrow the filter for more detail.
            </div>
          )}
        </div>

        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          {!selected || !decoded ? (
            <div className="nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
              Select an eval payload to inspect decoded code and values.
            </div>
          ) : (
            <div className={styles.stackMd}>
              <div className={styles.cardHeaderRow}>
                <div className="nx-min-w-0">
                  <div className="nx-text-sm nx-font-semibold">
                    {pathDisplay.displayPath(selected.id)}
                  </div>
                  <div className="nx-mt-1 nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
                    only: <code>{selected.only.join(', ') || '(none)'}</code>
                  </div>
                </div>
                <div className="nx-flex nx-flex-wrap nx-gap-2">
                  <Button
                    disabled={!decoded.code}
                    onClick={() =>
                      clipboard.copyText(decoded.code, 'Copied code')
                    }
                  >
                    Copy code
                  </Button>
                  <Button
                    disabled={!decoded.values}
                    onClick={() =>
                      clipboard.copyText(decoded.values, 'Copied values')
                    }
                  >
                    Copy values
                  </Button>
                </div>
              </div>

              {decoded.code && (
                <details open>
                  <summary className="nx-cursor-pointer nx-text-sm nx-font-semibold">
                    Code
                  </summary>
                  <pre className="nx-mt-2 nx-max-h-80 nx-overflow-auto nx-rounded-md nx-border nx-border-neutral-200 nx-bg-white nx-p-3 nx-text-xs dark:nx-border-neutral-800 dark:nx-bg-neutral-900">
                    <code>{decoded.code}</code>
                  </pre>
                </details>
              )}

              <details open>
                <summary className="nx-cursor-pointer nx-text-sm nx-font-semibold">
                  Values
                </summary>
                <pre className="nx-mt-2 nx-max-h-80 nx-overflow-auto nx-rounded-md nx-border nx-border-neutral-200 nx-bg-white nx-p-3 nx-text-xs dark:nx-border-neutral-800 dark:nx-bg-neutral-900">
                  <code>{decoded.values || '{}'}</code>
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
