import * as React from 'react';

import styles from '../LogAnalyzer.module.css';

import type { ParsedData } from '../state';
import { TruncateCell } from '../ui/TruncateCell';
import { cx, formatMs } from '../utils';

export function PerfSpansTab({ data }: { data: ParsedData }) {
  const { perfSpans } = data;

  if (!perfSpans) {
    return null;
  }

  return (
    <div className={styles.stackLg}>
      <div className={styles.metricsGrid}>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Perf spans
          </div>
          <div className="nx-mt-1 nx-text-2xl nx-font-semibold">
            {perfSpans.summary.totalSpans.toLocaleString()}
          </div>
        </div>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Total duration
          </div>
          <div className="nx-mt-1 nx-text-2xl nx-font-semibold">
            {formatMs(perfSpans.summary.totalDurationMs)}
          </div>
        </div>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Failed spans
          </div>
          <div className="nx-mt-1 nx-text-2xl nx-font-semibold">
            {perfSpans.summary.failedSpans.toLocaleString()}
          </div>
        </div>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Async spans
          </div>
          <div className="nx-mt-1 nx-text-2xl nx-font-semibold">
            {perfSpans.summary.asyncSpans.toLocaleString()}
          </div>
        </div>
      </div>

      <div className={styles.twoColGrid}>
        <div className="nx-rounded-lg nx-border nx-border-neutral-200 dark:nx-border-neutral-800">
          <div className="nx-border-b nx-border-neutral-200 nx-px-3 nx-py-2 nx-text-sm nx-font-semibold dark:nx-border-neutral-800">
            Top methods
          </div>
          <div className="nx-max-h-[560px] nx-overflow-auto">
            <table className={cx(styles.table, 'nx-w-full nx-text-sm')}>
              <colgroup>
                <col />
                <col style={{ width: 80 }} />
                <col style={{ width: 100 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 80 }} />
              </colgroup>
              <thead className="nx-bg-neutral-50 dark:nx-bg-neutral-950">
                <tr>
                  <th className="nx-px-3 nx-py-2 nx-text-left">method</th>
                  <th className="nx-px-3 nx-py-2 nx-text-right">count</th>
                  <th className="nx-px-3 nx-py-2 nx-text-right">total</th>
                  <th className="nx-px-3 nx-py-2 nx-text-right">avg</th>
                  <th className="nx-px-3 nx-py-2 nx-text-right">max</th>
                  <th className="nx-px-3 nx-py-2 nx-text-right">failed</th>
                  <th className="nx-px-3 nx-py-2 nx-text-right">async</th>
                </tr>
              </thead>
              <tbody>
                {perfSpans.summary.topMethods.map((method) => (
                  <tr
                    key={method.method}
                    className="nx-border-t nx-border-neutral-200 dark:nx-border-neutral-800"
                  >
                    <td className="nx-px-3 nx-py-2">
                      <TruncateCell
                        value={method.method}
                        title={method.method}
                      />
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      {method.count.toLocaleString()}
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      {formatMs(method.totalDurationMs)}
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      {formatMs(method.avgDurationMs)}
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      {formatMs(method.maxDurationMs)}
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      {method.failedSpans.toLocaleString()}
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      {method.asyncSpans.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="nx-rounded-lg nx-border nx-border-neutral-200 dark:nx-border-neutral-800">
          <div className="nx-border-b nx-border-neutral-200 nx-px-3 nx-py-2 nx-text-sm nx-font-semibold dark:nx-border-neutral-800">
            Slowest spans
          </div>
          <div className="nx-max-h-[560px] nx-overflow-auto">
            <table className={cx(styles.table, 'nx-w-full nx-text-sm')}>
              <colgroup>
                <col style={{ width: 70 }} />
                <col />
                <col style={{ width: 100 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 70 }} />
              </colgroup>
              <thead className="nx-bg-neutral-50 dark:nx-bg-neutral-950">
                <tr>
                  <th className="nx-px-3 nx-py-2 nx-text-right">span</th>
                  <th className="nx-px-3 nx-py-2 nx-text-left">method</th>
                  <th className="nx-px-3 nx-py-2 nx-text-right">duration</th>
                  <th className="nx-px-3 nx-py-2 nx-text-left">status</th>
                  <th className="nx-px-3 nx-py-2 nx-text-left">async</th>
                </tr>
              </thead>
              <tbody>
                {perfSpans.summary.slowestSpans.map((span) => (
                  <tr
                    key={`${span.lineNumber}:${span.spanId}`}
                    className="nx-border-t nx-border-neutral-200 dark:nx-border-neutral-800"
                  >
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      {span.spanId}
                    </td>
                    <td className="nx-px-3 nx-py-2">
                      <TruncateCell value={span.method} title={span.method} />
                    </td>
                    <td className="nx-px-3 nx-py-2 nx-text-right">
                      {formatMs(span.durationMs)}
                    </td>
                    <td className="nx-px-3 nx-py-2">{span.status}</td>
                    <td className="nx-px-3 nx-py-2">
                      {span.isAsync ? 'yes' : 'no'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
