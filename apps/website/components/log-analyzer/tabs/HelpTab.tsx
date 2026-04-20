import * as React from 'react';

import styles from '../LogAnalyzer.module.css';

import { FILE_NAME_BY_KEY, REQUIRED_FILENAMES } from '../constants';
import type { ParseErrors } from '../state';
import { cx } from '../utils';

export function HelpTab({ parseErrors }: { parseErrors: ParseErrors | null }) {
  return (
    <div className={styles.stackLg}>
      <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
        <div className="nx-text-sm nx-font-semibold">
          How to generate these logs
        </div>
        <p className="nx-mt-2 nx-text-sm nx-text-neutral-700 dark:nx-text-neutral-300">
          WyW bundler integrations support a <code>debug</code> option that
          writes these files to disk. Example (Vite):
        </p>
        <pre className="nx-mt-3 nx-overflow-x-auto nx-rounded-md nx-border nx-border-neutral-200 nx-bg-white nx-p-3 nx-text-xs dark:nx-border-neutral-800 dark:nx-bg-neutral-900">
          <code>{`// vite.config.ts
import wyw from '@wyw-in-js/vite';

export default {
  plugins: [
    wyw({
      debug: { dir: 'wyw-debug', print: true },
    }),
  ],
};`}</code>
        </pre>
        <p className="nx-mt-3 nx-text-sm nx-text-neutral-700 dark:nx-text-neutral-300">
          The directory will contain <code>actions.jsonl</code>,{' '}
          <code>dependencies.jsonl</code> and <code>entrypoints.jsonl</code>.
        </p>
      </div>

      <div className="nx-rounded-lg nx-border nx-border-neutral-200 nx-bg-neutral-50 nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-950">
        <div className="nx-text-sm nx-font-semibold">Parsing warnings</div>
        {!parseErrors ? (
          <div className="nx-mt-2 nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
            Parse the logs to see JSON parse warnings (if any).
          </div>
        ) : (
          <div className={cx('nx-mt-3', styles.stackMd)}>
            {REQUIRED_FILENAMES.map((k) => {
              const errors = parseErrors[k];
              if (!errors || errors.length === 0) return null;
              return (
                <details
                  key={k}
                  className="nx-rounded-md nx-border nx-border-neutral-200 nx-bg-white nx-p-3 dark:nx-border-neutral-800 dark:nx-bg-neutral-900"
                >
                  <summary className="nx-cursor-pointer nx-text-sm nx-font-medium">
                    <code>{FILE_NAME_BY_KEY[k]}</code>: {errors.length} JSON
                    parse errors
                  </summary>
                  <ul className={cx(styles.bulletList, 'nx-text-sm')}>
                    {errors.map((e) => (
                      <li key={`${e.lineNumber}:${e.message}`}>
                        line {e.lineNumber}: {e.message} —{' '}
                        <code>{e.linePreview}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
            {REQUIRED_FILENAMES.every((k) => parseErrors[k].length === 0) && (
              <div className="nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
                No JSON parse errors found.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
