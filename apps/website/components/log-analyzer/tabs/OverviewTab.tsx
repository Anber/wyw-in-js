import * as React from 'react';

import styles from '../LogAnalyzer.module.css';

import type { ParsedData } from '../state';
import { cx, formatMs } from '../utils';

export function OverviewTab({ data }: { data: ParsedData }) {
  return (
    <div className={styles.stackLg}>
      <div className={styles.metricsGrid}>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Wall time (span)
          </div>
          <div className="nx-mt-1 nx-text-2xl nx-font-semibold">
            {formatMs(data.actionsSummary.spanMs)}
          </div>
        </div>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Actions total
          </div>
          <div className="nx-mt-1 nx-text-2xl nx-font-semibold">
            {data.actionsSummary.totalActions.toLocaleString()}
          </div>
        </div>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Failed actions
          </div>
          <div className="nx-mt-1 nx-text-2xl nx-font-semibold">
            {data.actionsSummary.failedActions.toLocaleString()}
          </div>
        </div>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Async actions
          </div>
          <div className="nx-mt-1 nx-text-2xl nx-font-semibold">
            {data.actionsSummary.asyncActions.toLocaleString()}
          </div>
        </div>
      </div>

      <div className={styles.twoColGrid}>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-sm nx-font-semibold">
            Top action types — sum of durations
          </div>
          <div className="nx-mt-1 nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            This is a sum of action durations and can exceed the wall time due
            to overlap.
          </div>
          <ul className={cx(styles.plainList, 'nx-text-sm')}>
            {data.actionsSummary.topTypesByInclusiveMs.map(([type, ms]) => (
              <li key={type} className="nx-flex nx-gap-2">
                <code className="nx-flex-1 nx-truncate">{type}</code>
                <span className="nx-whitespace-nowrap">{formatMs(ms)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-sm nx-font-semibold">
            Top action types — exclusive wall-time
          </div>
          <div className="nx-mt-1 nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            A heuristic “who was on top of the stack” breakdown.
          </div>
          <ul className={cx(styles.plainList, 'nx-text-sm')}>
            {data.actionsSummary.topTypesByExclusiveMs.map(([type, ms]) => (
              <li key={type} className="nx-flex nx-gap-2">
                <code className="nx-flex-1 nx-truncate">{type}</code>
                <span className="nx-whitespace-nowrap">{formatMs(ms)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 nx-text-sm dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
        <div className="nx-font-semibold">Notes</div>
        <ul className={styles.bulletList}>
          <li>
            Skipped lines (shape mismatch): actions {data.skippedLines.actions},
            dependencies {data.skippedLines.dependencies}, entrypoints{' '}
            {data.skippedLines.entrypoints}
          </li>
          <li>
            <code>entrypointRef</code> in <code>actions.jsonl</code> is a stable
            internal reference (<code>idx#generation</code>), not a file path.
            The analyzer resolves it to a filename using{' '}
            <code>entrypoints.jsonl</code>.
          </li>
          <li>
            If you see a lot of “superseded” entrypoints for one file and the{' '}
            <code>only</code> set keeps growing, it usually indicates an
            invalidation storm.
          </li>
        </ul>
      </div>
    </div>
  );
}
