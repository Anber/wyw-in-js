import * as React from 'react';

import styles from '../LogAnalyzer.module.css';

import type { ActionsViewState } from '../useActionsView';
import type { ClipboardToastState } from '../useClipboardToast';
import type { PathDisplayState } from '../usePathDisplay';
import { useScrollIntoViewOnChange } from '../useScrollIntoViewOnChange';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { TruncateCell } from '../ui/TruncateCell';
import { cx, formatMs, onKeyboardActivate } from '../utils';

type ActionsTabProps = {
  clipboard: ClipboardToastState;
  nav: { openEntrypointsTabForFile: (filename: string) => void };
  pathDisplay: PathDisplayState;
  view: ActionsViewState;
};

export function ActionsTab({
  clipboard,
  nav,
  pathDisplay,
  view,
}: ActionsTabProps) {
  const {
    failedOnly,
    filterEntrypoint,
    filterImportFrom,
    filterType,
    limit,
    rows,
    selectedAction,
    setFailedOnly,
    setFilterEntrypoint,
    setFilterImportFrom,
    setFilterType,
    setLimit,
    setSelectedAction,
  } = view;

  const selectedActionDetailsRef = React.useRef<HTMLDivElement | null>(null);

  useScrollIntoViewOnChange(
    selectedActionDetailsRef,
    [selectedAction?.actionId],
    {
      enabled: !!selectedAction,
      behavior: 'smooth',
      block: 'nearest',
    }
  );

  return (
    <div className={styles.stackMd}>
      <div className={styles.filtersGrid}>
        <Field label="Filter type">
          <input
            value={filterType}
            onChange={(e) => setFilterType(e.currentTarget.value)}
            className={styles.fieldInput}
          />
        </Field>

        <Field label="Filter entrypoint">
          <input
            value={filterEntrypoint}
            onChange={(e) => setFilterEntrypoint(e.currentTarget.value)}
            placeholder="filename or entrypointRef"
            className={styles.fieldInput}
          />
        </Field>

        <Field label="Filter import (exact)">
          <input
            value={filterImportFrom}
            onChange={(e) => setFilterImportFrom(e.currentTarget.value)}
            placeholder="paste from Dependencies → Top imports"
            className={styles.fieldInput}
          />
        </Field>

        <Field label="Row limit">
          <input
            type="number"
            min={50}
            max={2000}
            value={limit}
            onChange={(e) => setLimit(Number(e.currentTarget.value))}
            className={styles.fieldInput}
          />
        </Field>
      </div>

      <div className={styles.inlineFieldRow}>
        <label className={styles.checkboxPill}>
          <input
            type="checkbox"
            checked={failedOnly}
            onChange={(e) => setFailedOnly(e.currentTarget.checked)}
            className="nx-h-4 nx-w-4 nx-rounded nx-border-neutral-300 dark:nx-border-neutral-700"
          />
          <span>Failed only</span>
        </label>

        <div className="nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
          Showing <strong>{rows.length}</strong> actions (sorted by duration).
          Click a row to expand details.
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
            {rows.map((a) => {
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
                      <TruncateCell value={a.type} title={a.type} />
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
                          title={`Open in Entrypoints: ${pathDisplay.displayPath(
                            entry
                          )}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            nav.openEntrypointsTabForFile(a.entrypointFilename!);
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
                            <span>{pathDisplay.displayPath(entry)}</span>
                          </code>
                        </button>
                      ) : (
                        <TruncateCell
                          value={pathDisplay.displayPath(entry)}
                          title={pathDisplay.displayPath(entry)}
                          startEllipsis
                        />
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
                              <Button
                                onClick={() =>
                                  clipboard.copyText(
                                    JSON.stringify(a, null, 2),
                                    'Copied action JSON'
                                  )
                                }
                              >
                                Copy JSON
                              </Button>

                              <Button
                                onClick={() =>
                                  clipboard.copyText(entry, 'Copied entrypoint')
                                }
                              >
                                Copy path
                              </Button>

                              {a.entrypointFilename && (
                                <Button
                                  onClick={() =>
                                    nav.openEntrypointsTabForFile(
                                      a.entrypointFilename!
                                    )
                                  }
                                >
                                  Open entrypoint
                                </Button>
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
