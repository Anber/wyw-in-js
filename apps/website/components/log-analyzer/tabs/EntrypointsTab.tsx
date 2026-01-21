import * as React from 'react';

import styles from '../LogAnalyzer.module.css';

import type { ClipboardToastState } from '../useClipboardToast';
import type { PathDisplayState } from '../usePathDisplay';
import { useScrollIntoViewOnChange } from '../useScrollIntoViewOnChange';
import type { EntrypointsViewState } from '../useEntrypointsView';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { TruncateCell } from '../ui/TruncateCell';
import { cx, onKeyboardActivate } from '../utils';

type EntrypointsTabProps = {
  clipboard: ClipboardToastState;
  nav: { openActionsTabForTarget: (target: string) => void };
  pathDisplay: PathDisplayState;
  view: EntrypointsViewState;
};

export function EntrypointsTab({
  clipboard,
  nav,
  pathDisplay,
  view,
}: EntrypointsTabProps) {
  const {
    filterFilename,
    filteredFiles,
    limit,
    selectedFile,
    selectedFileInstances,
    selectedInstance,
    selectedSeqId,
    selectedSupersedeChain,
    setFilterFilename,
    setLimit,
    selectFile,
    selectInstance,
  } = view;

  const selectedEntrypointDetailsRef = React.useRef<HTMLDivElement | null>(
    null
  );
  const selectedEntrypointInstanceRef = React.useRef<HTMLDivElement | null>(
    null
  );

  const [detailsScrollNonce, bumpDetailsScrollNonce] = React.useState(0);

  useScrollIntoViewOnChange(
    selectedEntrypointDetailsRef,
    [selectedFile, detailsScrollNonce],
    {
      enabled: !!selectedFile,
      schedule: 'raf-timeout',
      behavior: 'smooth',
      block: 'start',
    }
  );

  useScrollIntoViewOnChange(
    selectedEntrypointInstanceRef,
    [selectedSeqId],
    {
      enabled: selectedSeqId !== null,
      schedule: 'raf-timeout',
      behavior: 'smooth',
      block: 'start',
    }
  );

  return (
      <div className={styles.stackMd}>
        <div className={styles.filtersGrid}>
          <Field label="Filter filename">
            {({ describedBy, id }) => (
              <div className={styles.inlineFieldRow}>
                <input
                  id={id}
                  value={filterFilename}
                  onChange={(e) => setFilterFilename(e.currentTarget.value)}
                  aria-describedby={describedBy}
                  className={cx(styles.fieldFlex, styles.fieldInput)}
                />
                <Button
                  disabled={!filterFilename}
                  onClick={() => setFilterFilename('')}
                >
                  Reset
                </Button>
              </div>
            )}
          </Field>

        <Field label="Row limit">
          <input
            type="number"
            min={20}
            max={500}
            value={limit}
            onChange={(e) => setLimit(Number(e.currentTarget.value))}
            className={styles.fieldInput}
          />
        </Field>
      </div>

      <div className={styles.entrypointsLayout}>
        <div className="nx-overflow-x-auto nx-rounded-lg nx-border nx-border-neutral-200 dark:nx-border-neutral-800">
          <table className={cx(styles.table, 'nx-w-full nx-text-sm')}>
            <colgroup>
              <col />
              <col style={{ width: 90 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: 110 }} />
            </colgroup>
            <thead className="nx-bg-neutral-50 dark:nx-bg-neutral-950">
              <tr>
                <th className="nx-px-3 nx-py-2 nx-text-left">file</th>
                <th className="nx-px-3 nx-py-2 nx-text-right">created</th>
                <th className="nx-px-3 nx-py-2 nx-text-right">superseded</th>
                <th className="nx-px-3 nx-py-2 nx-text-right">only min</th>
                <th className="nx-px-3 nx-py-2 nx-text-right">only max</th>
                <th className="nx-px-3 nx-py-2 nx-text-right">only growth</th>
              </tr>
            </thead>
            <tbody>
              {filteredFiles.map((f) => {
                const growth =
                  f.onlyMin !== null && f.onlyMax !== null
                    ? f.onlyMax - f.onlyMin
                    : 0;
                const isSelected = selectedFile === f.filename;
                const select = () => {
                  selectFile(f.filename);
                  bumpDetailsScrollNonce((n) => n + 1);
                };
                return (
                  <tr
                    key={f.filename}
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
                        value={pathDisplay.displayPath(f.filename)}
                        title={pathDisplay.displayPath(f.filename)}
                        startEllipsis
                      />
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      {f.createdCount}
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      {f.supersededCount}
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      {f.onlyMin ?? '–'}
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      {f.onlyMax ?? '–'}
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">{growth}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div
          ref={selectedEntrypointDetailsRef}
          className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950"
        >
          {!selectedFile ? (
            <div className="nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
              Select a file to inspect entrypoint instances and supersede
              chains.
            </div>
          ) : (
            <div className={styles.stackMd}>
              <div className="nx-text-sm nx-font-semibold">
                Entrypoints for <code>{pathDisplay.displayPath(selectedFile)}</code>
              </div>

              <div className="nx-flex nx-flex-wrap nx-gap-2">
                <Button onClick={() => nav.openActionsTabForTarget(selectedFile)}>
                  Show actions (file)
                </Button>

                <Button
                  onClick={() =>
                    clipboard.copyText(selectedFile, 'Copied entrypoint filename')
                  }
                >
                  Copy path
                </Button>
              </div>

              <div className="nx-overflow-x-auto nx-rounded-lg nx-border nx-border-neutral-200 dark:nx-border-neutral-800">
                <table className={cx(styles.table, 'nx-w-full nx-text-sm')}>
                  <colgroup>
                    <col style={{ width: 80 }} />
                    <col />
                    <col style={{ width: 70 }} />
                    <col style={{ width: 80 }} />
                    <col style={{ width: 150 }} />
                  </colgroup>
                  <thead className="nx-bg-neutral-50 dark:nx-bg-neutral-950">
                    <tr>
                      <th className="nx-px-3 nx-py-2 nx-text-left">seqId</th>
                      <th className="nx-px-3 nx-py-2 nx-text-left">ref</th>
                      <th className="nx-px-3 nx-py-2 nx-text-right">gen</th>
                      <th className="nx-px-3 nx-py-2 nx-text-right">only</th>
                      <th className="nx-px-3 nx-py-2 nx-text-left">
                        superseded with
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedFileInstances.map((i) => {
                      const isSelected = selectedSeqId === i.seqId;
                      const select = () => selectInstance(i.seqId);
                      return (
                        <tr
                          key={i.seqId}
                          className={cx(
                            'nx-cursor-pointer nx-border-t nx-border-neutral-200 hover:nx-bg-neutral-50 focus-visible:nx-outline-none focus-visible:nx-ring-2 focus-visible:nx-ring-neutral-400 dark:nx-border-neutral-800 dark:hover:nx-bg-neutral-800 dark:focus-visible:nx-ring-neutral-500',
                            isSelected &&
                              'nx-bg-neutral-100 dark:nx-bg-neutral-800'
                          )}
                          tabIndex={0}
                          aria-selected={isSelected}
                          onClick={select}
                          onKeyDown={(e) => onKeyboardActivate(e, select)}
                        >
                          <td className="nx-px-3 nx-py-2">{i.seqId}</td>
                          <td className="nx-px-3 nx-py-2">
                            {i.ref ? (
                              <TruncateCell value={i.ref} title={i.ref} />
                            ) : (
                              '–'
                            )}
                          </td>
                          <td className="nx-px-3 nx-py-2 nx-text-right">
                            {i.generation ?? '–'}
                          </td>
                          <td className="nx-px-3 nx-py-2 nx-text-right">
                            {i.onlyLen ?? '–'}
                          </td>
                          <td className="nx-px-3 nx-py-2">
                            {i.supersededWith !== undefined
                              ? i.supersededWith
                              : '–'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {selectedInstance && (
                <div
                  ref={selectedEntrypointInstanceRef}
                  className={styles.stackSm}
                >
                  <div className="nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400">
                    Selected entrypoint instance
                  </div>
                  <div className="nx-flex nx-flex-wrap nx-gap-2">
                    {selectedInstance.ref && (
                      <Button
                        onClick={() =>
                          nav.openActionsTabForTarget(selectedInstance.ref!)
                        }
                      >
                        Show actions (ref)
                      </Button>
                    )}
                    <Button
                      onClick={() =>
                        clipboard.copyText(
                          JSON.stringify(selectedInstance, null, 2),
                          'Copied entrypoint JSON'
                        )
                      }
                    >
                      Copy JSON
                    </Button>
                  </div>
                  <pre className="nx-max-h-[40vh] nx-overflow-auto nx-rounded-md nx-border nx-border-neutral-200 nx-bg-white nx-p-3 nx-text-xs dark:nx-border-neutral-800 dark:nx-bg-neutral-900">
                    {JSON.stringify(selectedInstance, null, 2)}
                  </pre>
                </div>
              )}

              {selectedSupersedeChain.length > 0 && (
                <div className={styles.stackSm}>
                  <div className="nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400">
                    Supersede chain (seqId → seqId)
                  </div>
                  <ol className={cx(styles.orderedList, 'nx-text-sm')}>
                    {selectedSupersedeChain.map((i) => (
                      <li key={i.seqId}>
                        <code>
                          {i.seqId}
                          {i.ref ? ` (${i.ref})` : ''}
                          {i.supersededWith !== undefined
                            ? ` → ${i.supersededWith}`
                            : ''}
                        </code>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
