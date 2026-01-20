import * as React from 'react';

import styles from '../LogAnalyzer.module.css';

import { trimPathPrefix } from '../analyze';
import type { LogAnalyzerState } from '../useLogAnalyzerState';
import { cx, formatMs, onKeyboardActivate } from '../utils';

export function ActionsTab({ state }: { state: LogAnalyzerState }) {
  const {
    actionsFailedOnly,
    actionsFilterEntrypoint,
    actionsFilterImportFrom,
    actionsFilterType,
    actionsLimit,
    copyText,
    filteredActions,
    openEntrypointsTabForFile,
    pathPrefix,
    selectedAction,
    setActionsFailedOnly,
    setActionsFilterEntrypoint,
    setActionsFilterImportFrom,
    setActionsFilterType,
    setActionsLimit,
    setSelectedAction,
  } = state;

  const selectedActionDetailsRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!selectedAction) return;
    selectedActionDetailsRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  }, [selectedAction]);

  return (
    <div className={styles.stackMd}>
      <div className={styles.filtersGrid}>
        <label className="nx-grid nx-gap-1">
          <span className="nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400">
            Filter type
          </span>
          <input
            value={actionsFilterType}
            onChange={(e) => setActionsFilterType(e.currentTarget.value)}
            className={styles.fieldInput}
          />
        </label>

        <label className="nx-grid nx-gap-1">
          <span className="nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400">
            Filter entrypoint
          </span>
          <input
            value={actionsFilterEntrypoint}
            onChange={(e) => setActionsFilterEntrypoint(e.currentTarget.value)}
            placeholder="filename or entrypointRef"
            className={styles.fieldInput}
          />
        </label>

        <label className="nx-grid nx-gap-1">
          <span className="nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400">
            Filter import (exact)
          </span>
          <input
            value={actionsFilterImportFrom}
            onChange={(e) => setActionsFilterImportFrom(e.currentTarget.value)}
            placeholder="paste from Dependencies → Top imports"
            className={styles.fieldInput}
          />
        </label>

        <label className="nx-grid nx-gap-1">
          <span className="nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400">
            Row limit
          </span>
          <input
            type="number"
            min={50}
            max={2000}
            value={actionsLimit}
            onChange={(e) => setActionsLimit(Number(e.currentTarget.value))}
            className={styles.fieldInput}
          />
        </label>
      </div>

      <div className={styles.inlineFieldRow}>
        <label className={styles.checkboxPill}>
          <input
            type="checkbox"
            checked={actionsFailedOnly}
            onChange={(e) => setActionsFailedOnly(e.currentTarget.checked)}
            className="nx-h-4 nx-w-4 nx-rounded nx-border-neutral-300 dark:nx-border-neutral-700"
          />
          <span>Failed only</span>
        </label>

        <div className="nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
          Showing <strong>{filteredActions.length}</strong> actions (sorted by
          duration). Click a row to expand details.
        </div>
      </div>

      <div className="nx-overflow-x-auto nx-rounded-lg nx-border nx-border-neutral-200 dark:nx-border-neutral-800">
        <table className={cx(styles.table, 'nx-w-full nx-text-sm')}>
          <colgroup>
            <col style={{ width: 110 }} />
            <col style={{ width: 260 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 70 }} />
            <col />
            <col style={{ width: 110 }} />
          </colgroup>
          <thead className="nx-bg-neutral-50 dark:nx-bg-neutral-950">
            <tr className="nx-text-left">
              <th className="nx-whitespace-nowrap nx-px-3 nx-py-2">duration</th>
              <th className="nx-whitespace-nowrap nx-px-3 nx-py-2">type</th>
              <th className="nx-whitespace-nowrap nx-px-3 nx-py-2">result</th>
              <th className="nx-whitespace-nowrap nx-px-3 nx-py-2">async</th>
              <th className="nx-whitespace-nowrap nx-px-3 nx-py-2">
                entrypoint
              </th>
              <th className="nx-whitespace-nowrap nx-px-3 nx-py-2">actionId</th>
            </tr>
          </thead>
          <tbody>
            {filteredActions.map((a) => {
              const entry = a.entrypointFilename ?? a.entrypointRef;
              const isSelected = selectedAction?.actionId === a.actionId;
              const toggle = () => setSelectedAction(isSelected ? null : a);
              return (
                <React.Fragment key={a.actionId}>
                  <tr
                    className={cx(
                      'nx-cursor-pointer nx-border-t nx-border-neutral-200 hover:nx-bg-neutral-50 focus-visible:nx-outline-none focus-visible:nx-ring-2 focus-visible:nx-ring-neutral-400 dark:nx-border-neutral-800 dark:hover:nx-bg-neutral-800 dark:focus-visible:nx-ring-neutral-500',
                      isSelected && 'nx-bg-neutral-100 dark:nx-bg-neutral-800'
                    )}
                    tabIndex={0}
                    aria-selected={isSelected}
                    onClick={toggle}
                    onKeyDown={(e) => onKeyboardActivate(e, toggle)}
                  >
                    <td className="nx-whitespace-nowrap nx-px-3 nx-py-2">
                      {formatMs(a.durationMs)}
                    </td>
                    <td className="nx-px-3 nx-py-2">
                      <code className={styles.cellTruncate} title={a.type}>
                        {a.type}
                      </code>
                    </td>
                    <td className="nx-whitespace-nowrap nx-px-3 nx-py-2">
                      {a.result}
                    </td>
                    <td className="nx-whitespace-nowrap nx-px-3 nx-py-2">
                      {a.isAsync ? 'yes' : 'no'}
                    </td>
                    <td className="nx-px-3 nx-py-2">
                      {a.entrypointFilename ? (
                        <button
                          type="button"
                          className={styles.entryLink}
                          title={`Open in Entrypoints: ${trimPathPrefix(
                            entry,
                            pathPrefix
                          )}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            openEntrypointsTabForFile(a.entrypointFilename!);
                          }}
                        >
                          <span className={styles.entryLinkIcon} aria-hidden>
                            ↗
                          </span>
                          <code
                            className={cx(
                              styles.cellTruncate,
                              styles.cellTruncateStart
                            )}
                          >
                            <span>{trimPathPrefix(entry, pathPrefix)}</span>
                          </code>
                        </button>
                      ) : (
                        <code
                          className={cx(
                            styles.cellTruncate,
                            styles.cellTruncateStart
                          )}
                          title={trimPathPrefix(entry, pathPrefix)}
                        >
                          <span>{trimPathPrefix(entry, pathPrefix)}</span>
                        </code>
                      )}
                    </td>
                    <td className="nx-whitespace-nowrap nx-px-3 nx-py-2">
                      {a.actionId}
                    </td>
                  </tr>

                  {isSelected && (
                    <tr
                      className={cx(
                        'nx-border-t nx-border-neutral-200 dark:nx-border-neutral-800',
                        styles.detailsRow
                      )}
                    >
                      <td colSpan={6} className={styles.detailsCell}>
                        <div
                          ref={selectedActionDetailsRef}
                          className={styles.detailsPanel}
                        >
                          <div className={styles.detailsHeader}>
                            <div className="nx-text-sm nx-font-semibold">
                              <code>{a.type}</code> — {formatMs(a.durationMs)}
                            </div>
                            <div className={styles.detailsButtons}>
                              <button
                                type="button"
                                className={cx(
                                  styles.button,
                                  styles.buttonSecondary
                                )}
                                onClick={() =>
                                  copyText(
                                    JSON.stringify(a, null, 2),
                                    'Copied action JSON'
                                  )
                                }
                              >
                                Copy JSON
                              </button>

                              <button
                                type="button"
                                className={cx(
                                  styles.button,
                                  styles.buttonSecondary
                                )}
                                onClick={() =>
                                  copyText(entry, 'Copied entrypoint')
                                }
                              >
                                Copy path
                              </button>

                              {a.entrypointFilename && (
                                <button
                                  type="button"
                                  className={cx(
                                    styles.button,
                                    styles.buttonSecondary
                                  )}
                                  onClick={() =>
                                    openEntrypointsTabForFile(
                                      a.entrypointFilename!
                                    )
                                  }
                                >
                                  Open entrypoint
                                </button>
                              )}
                            </div>
                          </div>

                          <pre className="nx-max-h-[60vh] nx-overflow-auto nx-rounded-md nx-border nx-border-neutral-200 nx-bg-white nx-p-3 nx-text-xs dark:nx-border-neutral-800 dark:nx-bg-neutral-900">
                            {JSON.stringify(a, null, 2)}
                          </pre>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
