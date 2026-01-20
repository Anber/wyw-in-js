import * as React from 'react';

import styles from '../LogAnalyzer.module.css';

import { trimPathPrefix } from '../analyze';
import type { LogAnalyzerState } from '../useLogAnalyzerState';
import { cx, onKeyboardActivate } from '../utils';

export function EntrypointsTab({ state }: { state: LogAnalyzerState }) {
  const {
    copyText,
    entrypointsFilter,
    entrypointsLimit,
    openActionsTabForEntrypoint,
    pathPrefix,
    filteredEntrypointFiles,
    selectedEntrypointFile,
    selectedEntrypointInstance,
    selectedEntrypointSeqId,
    selectedFileInstances,
    selectedSupersedeChain,
    setEntrypointsFilter,
    setEntrypointsLimit,
    setSelectedEntrypointFile,
    setSelectedEntrypointSeqId,
  } = state;

  const selectedEntrypointDetailsRef = React.useRef<HTMLDivElement | null>(
    null
  );
  const selectedEntrypointInstanceRef = React.useRef<HTMLDivElement | null>(
    null
  );

  const scrollToDetails = React.useCallback(() => {
    selectedEntrypointDetailsRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, []);

  const scheduleScrollToDetails = React.useCallback(() => {
    requestAnimationFrame(() => {
      scrollToDetails();
      setTimeout(scrollToDetails, 0);
    });
  }, [scrollToDetails]);

  const scrollToInstance = React.useCallback(() => {
    selectedEntrypointInstanceRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, []);

  const scheduleScrollToInstance = React.useCallback(() => {
    requestAnimationFrame(() => {
      scrollToInstance();
      setTimeout(scrollToInstance, 0);
    });
  }, [scrollToInstance]);

  React.useEffect(() => {
    if (!selectedEntrypointFile) return;
    scheduleScrollToDetails();
  }, [scheduleScrollToDetails, selectedEntrypointFile]);

  React.useEffect(() => {
    if (selectedEntrypointSeqId === null) return;
    scheduleScrollToInstance();
  }, [scheduleScrollToInstance, selectedEntrypointSeqId]);

  return (
    <div className={styles.stackMd}>
      <div className={styles.filtersGrid}>
        <div className="nx-grid nx-gap-1">
          <span className="nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400">
            Filter filename
          </span>
          <div className={styles.inlineFieldRow}>
            <input
              value={entrypointsFilter}
              onChange={(e) => setEntrypointsFilter(e.currentTarget.value)}
              aria-label="Filter filename"
              className={cx(styles.fieldFlex, styles.fieldInput)}
            />
            <button
              type="button"
              disabled={!entrypointsFilter}
              onClick={() => setEntrypointsFilter('')}
              className={cx(styles.button, styles.buttonSecondary)}
            >
              Reset
            </button>
          </div>
        </div>
        <label className="nx-grid nx-gap-1">
          <span className="nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400">
            Row limit
          </span>
          <input
            type="number"
            min={20}
            max={500}
            value={entrypointsLimit}
            onChange={(e) => setEntrypointsLimit(Number(e.currentTarget.value))}
            className={styles.fieldInput}
          />
        </label>
      </div>

      <div className={styles.entrypointsLayout}>
        <div className="nx-overflow-x-auto nx-rounded-lg nx-border nx-border-neutral-200 dark:nx-border-neutral-800">
          <table className={cx(styles.table, 'nx-w-full nx-text-sm')}>
            <colgroup>
              <col />
              <col style={{ width: 90 }} />
              <col style={{ width: 110 }} />
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
              {filteredEntrypointFiles.map((f) => {
                const growth =
                  f.onlyMin !== null && f.onlyMax !== null
                    ? f.onlyMax - f.onlyMin
                    : 0;
                const isSelected = selectedEntrypointFile === f.filename;
                const select = () => {
                  setSelectedEntrypointFile(f.filename);
                  setSelectedEntrypointSeqId(null);
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
                      <code
                        className={cx(
                          styles.cellTruncate,
                          styles.cellTruncateStart
                        )}
                        title={trimPathPrefix(f.filename, pathPrefix)}
                      >
                        <span>{trimPathPrefix(f.filename, pathPrefix)}</span>
                      </code>
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
          {!selectedEntrypointFile ? (
            <div className="nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
              Select a file to inspect entrypoint instances and supersede
              chains.
            </div>
          ) : (
            <div className={styles.stackMd}>
              <div className="nx-text-sm nx-font-semibold">
                Entrypoints for{' '}
                <code>
                  {trimPathPrefix(selectedEntrypointFile, pathPrefix)}
                </code>
              </div>

              <div className="nx-flex nx-flex-wrap nx-gap-2">
                <button
                  type="button"
                  className={cx(styles.button, styles.buttonSecondary)}
                  onClick={() =>
                    openActionsTabForEntrypoint(selectedEntrypointFile)
                  }
                >
                  Show actions (file)
                </button>

                <button
                  type="button"
                  className={cx(styles.button, styles.buttonSecondary)}
                  onClick={() =>
                    copyText(
                      selectedEntrypointFile,
                      'Copied entrypoint filename'
                    )
                  }
                >
                  Copy path
                </button>
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
                      const isSelected = selectedEntrypointSeqId === i.seqId;
                      const select = () => setSelectedEntrypointSeqId(i.seqId);
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
                            <code
                              className={styles.cellTruncate}
                              title={i.ref ?? '–'}
                            >
                              {i.ref ?? '–'}
                            </code>
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

              {selectedEntrypointInstance && (
                <div
                  ref={selectedEntrypointInstanceRef}
                  className={styles.stackSm}
                >
                  <div className="nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400">
                    Selected entrypoint instance
                  </div>
                  <div className="nx-flex nx-flex-wrap nx-gap-2">
                    {selectedEntrypointInstance.ref && (
                      <button
                        type="button"
                        className={cx(styles.button, styles.buttonSecondary)}
                        onClick={() =>
                          openActionsTabForEntrypoint(
                            selectedEntrypointInstance.ref!
                          )
                        }
                      >
                        Show actions (ref)
                      </button>
                    )}
                    <button
                      type="button"
                      className={cx(styles.button, styles.buttonSecondary)}
                      onClick={() =>
                        copyText(
                          JSON.stringify(selectedEntrypointInstance, null, 2),
                          'Copied entrypoint JSON'
                        )
                      }
                    >
                      Copy JSON
                    </button>
                  </div>
                  <pre className="nx-max-h-[40vh] nx-overflow-auto nx-rounded-md nx-border nx-border-neutral-200 nx-bg-white nx-p-3 nx-text-xs dark:nx-border-neutral-800 dark:nx-bg-neutral-900">
                    {JSON.stringify(selectedEntrypointInstance, null, 2)}
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
