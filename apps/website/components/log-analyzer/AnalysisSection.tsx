import * as React from 'react';

import styles from './LogAnalyzer.module.css';

import type { LogAnalyzerState } from './useLogAnalyzerState';
import { cx } from './utils';
import { ActionsTab } from './tabs/ActionsTab';
import { DependenciesTab } from './tabs/DependenciesTab';
import { EntrypointsTab } from './tabs/EntrypointsTab';
import { HelpTab } from './tabs/HelpTab';
import { OverviewTab } from './tabs/OverviewTab';

export function AnalysisSection({ state }: { state: LogAnalyzerState }) {
  const {
    activeTab,
    clearPathPrefix,
    copyMessage,
    data,
    pathPrefix,
    resetPathPrefixToAuto,
    setActiveTab,
    setPathPrefix,
  } = state;

  if (!data) return null;

  return (
    <section className="nx-rounded-xl nx-border nx-border-neutral-200 nx-bg-white nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-900 sm:nx-p-6">
      <div className={styles.stackLg}>
        <div className="nx-flex nx-flex-wrap nx-items-center nx-justify-between nx-gap-4">
          <h2 className="nx-text-lg nx-font-semibold">Analysis</h2>
          <nav className="nx-inline-flex nx-flex-wrap nx-gap-2">
            {(
              [
                ['overview', 'Overview'],
                ['actions', 'Actions'],
                ['entrypoints', 'Entrypoints'],
                ['dependencies', 'Dependencies'],
                ['help', 'Help'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={cx(
                  styles.tabButton,
                  activeTab === id && styles.tabButtonActive
                )}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>

        <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
          <div className="nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400">
            Path display
          </div>
          <div className={styles.stackSm}>
            <div className="nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400">
              Trim common path prefix
            </div>
            <div className={styles.pathDisplayControls}>
              <div className={styles.pathDisplayInput}>
                <input
                  value={pathPrefix}
                  onChange={(e) => setPathPrefix(e.currentTarget.value)}
                  placeholder={data.pathPrefix || '(auto-detect failed)'}
                  aria-label="Trim common path prefix"
                  className={styles.fieldInput}
                />
              </div>

              <button
                type="button"
                onClick={resetPathPrefixToAuto}
                className={cx(styles.button, styles.buttonSecondary)}
              >
                Auto
              </button>

              <button
                type="button"
                onClick={clearPathPrefix}
                className={cx(styles.button, styles.buttonSecondary)}
              >
                Clear
              </button>
            </div>
          </div>
          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Affects how file paths are shown across all tabs (does not change
            the analysis).
          </div>
          {copyMessage && (
            <div
              className="nx-text-xs nx-font-semibold nx-text-neutral-700 dark:nx-text-neutral-300"
              role="status"
              aria-live="polite"
            >
              {copyMessage}
            </div>
          )}
        </div>

        {activeTab === 'overview' && <OverviewTab state={state} />}
        {activeTab === 'actions' && <ActionsTab state={state} />}
        {activeTab === 'entrypoints' && <EntrypointsTab state={state} />}
        {activeTab === 'dependencies' && <DependenciesTab state={state} />}
        {activeTab === 'help' && <HelpTab state={state} />}
      </div>
    </section>
  );
}
