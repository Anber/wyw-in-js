import * as React from 'react';

import styles from './LogAnalyzer.module.css';

import { AnalysisSection } from './AnalysisSection';
import { UploadSection } from './UploadSection';
import { useLogAnalyzerState } from './useLogAnalyzerState';

export function LogAnalyzer() {
  const state = useLogAnalyzerState();

  return (
    <div className="nx-min-h-screen nx-bg-neutral-50 nx-text-neutral-900 dark:nx-bg-neutral-950 dark:nx-text-neutral-100">
      <div className="nx-mx-auto nx-max-w-7xl nx-px-4 nx-py-8 sm:nx-px-6 lg:nx-px-8">
        <header className={styles.stackSm}>
          <h1 className="nx-text-3xl nx-font-semibold nx-tracking-tight">
            WyW log analyzer
          </h1>
          <p className="nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
            Analyze WyW debug logs (<code>actions.jsonl</code>,{' '}
            <code>dependencies.jsonl</code>, <code>entrypoints.jsonl</code>).
            Runs fully in your browser — files are not uploaded anywhere.
          </p>
        </header>

        <div className={styles.pageSections}>
          <UploadSection state={state} />
          <AnalysisSection state={state} />
        </div>
      </div>
    </div>
  );
}
