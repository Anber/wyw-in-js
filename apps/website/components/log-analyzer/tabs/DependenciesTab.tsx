import * as React from 'react';

import styles from '../LogAnalyzer.module.css';

import { trimPathPrefix } from '../analyze';
import type { LogAnalyzerState } from '../useLogAnalyzerState';
import { cx, onKeyboardActivate } from '../utils';

export function DependenciesTab({ state }: { state: LogAnalyzerState }) {
  const {
    copyText,
    data,
    importQuery,
    matchedImports,
    openActionsTabForEntrypoint,
    openActionsTabForImport,
    pathPrefix,
    selectedImport,
    selectedImporters,
    setImportQuery,
    setSelectedImport,
  } = state;

  const selectedImportersRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!selectedImport) return;
    selectedImportersRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  }, [selectedImport]);

  if (!data) return null;

  return (
    <div className={styles.stackMd}>
      <div className="nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
        <strong>{data.dependencies.filesCount}</strong> files,{' '}
        <strong>{data.dependencies.importsCount}</strong> import edges.
      </div>

      <label className="nx-grid nx-gap-1">
        <span className="nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400">
          Find import specifier
        </span>
        <input
          value={importQuery}
          onChange={(e) => setImportQuery(e.currentTarget.value)}
          placeholder="e.g. @radix-ui/react-dialog"
          className={styles.fieldInput}
        />
      </label>

      <div className={styles.twoColGrid}>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 dark:nx-border-neutral-800">
          <div className="nx-border-b nx-border-neutral-200 nx-px-3 nx-py-2 nx-text-sm nx-font-semibold dark:nx-border-neutral-800">
            Top imports
          </div>
          <div className="nx-overflow-x-auto">
            <table className={cx(styles.table, 'nx-w-full nx-text-sm')}>
              <colgroup>
                <col />
                <col style={{ width: 90 }} />
                <col style={{ width: 110 }} />
              </colgroup>
              <thead className="nx-bg-neutral-50 dark:nx-bg-neutral-950">
                <tr>
                  <th className="nx-px-3 nx-py-2 nx-text-left">from</th>
                  <th className="nx-px-3 nx-py-2 nx-text-right">count</th>
                  <th className="nx-px-3 nx-py-2 nx-text-right">importers</th>
                </tr>
              </thead>
              <tbody>
                {matchedImports.map((row) => {
                  const isSelected = selectedImport === row.from;
                  const select = () => setSelectedImport(row.from);
                  return (
                    <tr
                      key={row.from}
                      className={cx(
                        'nx-cursor-pointer nx-border-t nx-border-neutral-200 hover:nx-bg-neutral-50 focus-visible:nx-outline-none focus-visible:nx-ring-2 focus-visible:nx-ring-neutral-400 dark:nx-border-neutral-800 dark:hover:nx-bg-neutral-800 dark:focus-visible:nx-ring-neutral-500',
                        isSelected && 'nx-bg-neutral-100 dark:nx-bg-neutral-800'
                      )}
                      tabIndex={0}
                      aria-selected={isSelected}
                      onClick={select}
                      onKeyDown={(e) => onKeyboardActivate(e, select)}
                    >
                      <td className="nx-px-3 nx-py-2">
                        <code
                          className={cx(
                            styles.cellTruncate,
                            styles.cellTruncateStart
                          )}
                          title={row.from}
                        >
                          <span>{row.from}</span>
                        </code>
                      </td>
                      <td className="nx-px-3 nx-py-2 nx-text-right">
                        {row.count}
                      </td>
                      <td className="nx-px-3 nx-py-2 nx-text-right">
                        {row.importersCount}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="nx-rounded-lg nx-border nx-border-neutral-200 dark:nx-border-neutral-800">
          <div className="nx-border-b nx-border-neutral-200 nx-px-3 nx-py-2 nx-text-sm nx-font-semibold dark:nx-border-neutral-800">
            Top packages
          </div>
          <div className="nx-overflow-x-auto">
            <table className={cx(styles.table, 'nx-w-full nx-text-sm')}>
              <colgroup>
                <col />
                <col style={{ width: 90 }} />
              </colgroup>
              <thead className="nx-bg-neutral-50 dark:nx-bg-neutral-950">
                <tr>
                  <th className="nx-px-3 nx-py-2 nx-text-left">package</th>
                  <th className="nx-px-3 nx-py-2 nx-text-right">count</th>
                </tr>
              </thead>
              <tbody>
                {data.dependencies.topPackages.map((p) => (
                  <tr
                    key={p.name}
                    className="nx-border-t nx-border-neutral-200 dark:nx-border-neutral-800"
                  >
                    <td className="nx-px-3 nx-py-2">
                      <code className={styles.cellTruncate} title={p.name}>
                        {p.name}
                      </code>
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">{p.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {selectedImport && (
        <div
          ref={selectedImportersRef}
          className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950"
        >
          <div className={styles.cardHeaderRow}>
            <div className="nx-text-sm nx-font-semibold">
              Importers of <code>{selectedImport}</code>
            </div>
            <div className="nx-flex nx-flex-wrap nx-gap-2">
              <button
                type="button"
                className={cx(styles.button, styles.buttonSecondary)}
                onClick={() =>
                  copyText(selectedImport, 'Copied import specifier')
                }
              >
                Copy
              </button>
              <button
                type="button"
                className={cx(styles.button, styles.buttonSecondary)}
                onClick={() => openActionsTabForImport(selectedImport)}
              >
                Show actions
              </button>
            </div>
          </div>
          <div className="nx-mt-3 nx-overflow-x-auto nx-rounded-md nx-border nx-border-neutral-200 dark:nx-border-neutral-800">
            <table className={cx(styles.table, 'nx-w-full nx-text-sm')}>
              <colgroup>
                <col />
                <col style={{ width: 140 }} />
              </colgroup>
              <thead className="nx-bg-neutral-50 dark:nx-bg-neutral-950">
                <tr>
                  <th className="nx-px-3 nx-py-2 nx-text-left">importer</th>
                  <th className="nx-px-3 nx-py-2 nx-text-right">actions</th>
                </tr>
              </thead>
              <tbody>
                {selectedImporters.slice(0, 200).map((f) => (
                  <tr
                    key={f}
                    className="nx-border-t nx-border-neutral-200 dark:nx-border-neutral-800"
                  >
                    <td className="nx-px-3 nx-py-2">
                      <code
                        className={cx(
                          styles.cellTruncate,
                          styles.cellTruncateStart
                        )}
                        title={trimPathPrefix(f, pathPrefix)}
                      >
                        <span>{trimPathPrefix(f, pathPrefix)}</span>
                      </code>
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      <button
                        type="button"
                        className={cx(styles.button, styles.buttonSecondary)}
                        title="Filter Actions by this entrypoint"
                        onClick={() => openActionsTabForEntrypoint(f)}
                      >
                        ↗ Actions
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selectedImporters.length > 200 && (
            <div className="nx-mt-2 nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
              Showing first 200 importers.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
