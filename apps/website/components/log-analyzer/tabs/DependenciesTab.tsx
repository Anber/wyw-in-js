import * as React from 'react';

import styles from '../LogAnalyzer.module.css';

import type { ParsedData } from '../state';
import type { DependenciesViewState } from '../useDependenciesView';
import type { ClipboardToastState } from '../useClipboardToast';
import type { PathDisplayState } from '../usePathDisplay';
import { useScrollIntoViewOnChange } from '../useScrollIntoViewOnChange';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { TruncateCell } from '../ui/TruncateCell';
import { cx, onKeyboardActivate } from '../utils';

type DependenciesTabProps = {
  clipboard: ClipboardToastState;
  data: ParsedData;
  nav: {
    openActionsTabForEntrypoint: (entrypoint: string) => void;
    openActionsTabForImport: (from: string) => void;
  };
  pathDisplay: PathDisplayState;
  view: DependenciesViewState;
};

export function DependenciesTab({
  clipboard,
  data,
  nav,
  pathDisplay,
  view,
}: DependenciesTabProps) {
  const {
    importQuery,
    matchedImports,
    selectedImport,
    selectedImporters,
    setImportQuery,
    setSelectedImport,
  } = view;

  const selectedImportersRef = React.useRef<HTMLDivElement | null>(null);

  useScrollIntoViewOnChange(selectedImportersRef, [selectedImport], {
    enabled: !!selectedImport,
    behavior: 'smooth',
    block: 'nearest',
  });

  return (
    <div className={styles.stackMd}>
      <div className="nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
        <strong>{data.dependencies.filesCount}</strong> files,{' '}
        <strong>{data.dependencies.importsCount}</strong> import edges.
      </div>

      <Field label="Find import specifier">
        <input
          value={importQuery}
          onChange={(e) => setImportQuery(e.currentTarget.value)}
          placeholder="e.g. @radix-ui/react-dialog"
          className={styles.fieldInput}
        />
      </Field>

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
                        <TruncateCell
                          value={pathDisplay.displayPath(row.from)}
                          title={pathDisplay.displayPath(row.from)}
                          startEllipsis
                        />
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
                      <TruncateCell value={p.name} title={p.name} />
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
              Importers of <code>{pathDisplay.displayPath(selectedImport)}</code>
            </div>
            <div className="nx-flex nx-flex-wrap nx-gap-2">
              <Button
                onClick={() =>
                  clipboard.copyText(selectedImport, 'Copied import specifier')
                }
              >
                Copy
              </Button>
              <Button
                onClick={() => nav.openActionsTabForImport(selectedImport)}
              >
                Show actions
              </Button>
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
                      <TruncateCell
                        value={pathDisplay.displayPath(f)}
                        title={pathDisplay.displayPath(f)}
                        startEllipsis
                      />
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      <Button
                        title="Filter Actions by this entrypoint"
                        onClick={() => nav.openActionsTabForEntrypoint(f)}
                      >
                        ↗ Actions
                      </Button>
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
