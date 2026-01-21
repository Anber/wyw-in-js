import * as React from 'react';

import styles from './LogAnalyzer.module.css';

import { FILE_NAME_BY_KEY, REQUIRED_FILENAMES } from './constants';
import { DirectoryInput } from './DirectoryInput';
import type { LogAnalyzerState } from './useLogAnalyzerState';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { cx, formatBytes } from './utils';

export function UploadSection({ state }: { state: LogAnalyzerState }) {
  const { parseLogs, resetAll, upload, parse } = state;

  const { canParse, inputsKey, onDrop, onPickFiles, problems, selected } =
    upload;
  const { fatalError, isParsing, parseProgress } = parse;

  return (
    <section className="nx-rounded-xl nx-border nx-border-neutral-200 nx-bg-white nx-p-4 dark:nx-border-neutral-800 dark:nx-bg-neutral-900 sm:nx-p-6">
      <div className="nx-flex nx-flex-wrap nx-items-start nx-justify-between nx-gap-4">
        <div className={styles.stackSm}>
          <h2 className="nx-text-lg nx-font-semibold">Upload logs</h2>
          <p className="nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
            Drag &amp; drop the 3 files, or pick them using the inputs.
          </p>
        </div>

        <div className="nx-flex nx-flex-wrap nx-items-center nx-gap-2">
          <Button
            variant="primary"
            disabled={!canParse || isParsing}
            onClick={() => parseLogs().catch(() => {})}
          >
            {isParsing ? 'Parsing…' : 'Parse logs'}
          </Button>

          <Button onClick={resetAll}>Reset</Button>
        </div>
      </div>

      <div className="nx-mt-4 nx-grid nx-gap-4 lg:nx-grid-cols-2">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          className={cx(
            'nx-rounded-lg nx-border nx-border-dashed nx-p-4',
            isParsing
              ? 'nx-cursor-not-allowed nx-border-neutral-200 nx-bg-neutral-50 dark:nx-border-neutral-800 dark:nx-bg-neutral-950'
              : 'nx-border-neutral-300 nx-bg-neutral-50 dark:nx-border-neutral-700 dark:nx-bg-neutral-950'
          )}
        >
          <div className="nx-text-sm nx-font-medium">Drop zone</div>
          <p className="nx-mt-1 nx-text-sm nx-text-neutral-600 dark:nx-text-neutral-400">
            Drop <code>actions.jsonl</code>, <code>dependencies.jsonl</code> and{' '}
            <code>entrypoints.jsonl</code> here.
          </p>

          <div className="nx-mt-4 nx-grid nx-gap-2 nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            {REQUIRED_FILENAMES.map((k) => {
              const f = selected[k];
              return (
                <div key={k} className="nx-flex nx-items-baseline nx-gap-2">
                  <code className="nx-whitespace-nowrap">
                    {FILE_NAME_BY_KEY[k]}
                  </code>
                  <span className="nx-truncate">
                    {f ? `${f.name} (${formatBytes(f.size)})` : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="nx-grid nx-content-start nx-gap-4">
          <Field label="Pick files" labelClassName="nx-text-sm nx-font-medium">
            <input
              key={`files-${inputsKey}`}
              type="file"
              multiple
              disabled={isParsing}
              onChange={(e) =>
                onPickFiles(Array.from(e.currentTarget.files ?? []))
              }
              className={styles.fieldInput}
            />
          </Field>

          <Field
            label="Pick folder"
            labelClassName="nx-text-sm nx-font-medium"
            hint={
              <>
                Folder picker works in Chromium-based browsers. In Firefox, use
                “Pick files” or drag&amp;drop.
              </>
            }
          >
            <DirectoryInput
              key={`dir-${inputsKey}`}
              disabled={isParsing}
              onFiles={onPickFiles}
              className={styles.fieldInput}
            />
          </Field>

          <div className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
            Expected file names: <code>{FILE_NAME_BY_KEY.actions}</code>,{' '}
            <code>{FILE_NAME_BY_KEY.dependencies}</code>,{' '}
            <code>{FILE_NAME_BY_KEY.entrypoints}</code>
          </div>
        </div>
      </div>

      {problems.length > 0 && (
        <div className="nx-mt-4 nx-rounded-lg nx-border nx-border-amber-200 nx-bg-amber-50 nx-p-4 nx-text-sm dark:nx-border-amber-900/50 dark:nx-bg-amber-950/30">
          <div className="nx-font-semibold">Upload issues</div>
          <ul className={styles.bulletList}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {parseProgress && (
        <div className={cx('nx-mt-4', styles.stackSm)}>
          <div className="nx-text-sm">
            <span className="nx-font-semibold">Parsing:</span>{' '}
            <code>{FILE_NAME_BY_KEY[parseProgress.file]}</code> —{' '}
            {formatBytes(parseProgress.progress.bytesRead)} /{' '}
            {formatBytes(parseProgress.progress.bytesTotal)} —{' '}
            {parseProgress.progress.lines.toLocaleString()} lines
          </div>
          <progress
            className="nx-h-2 nx-w-full nx-overflow-hidden nx-rounded-full"
            value={parseProgress.progress.bytesRead}
            max={parseProgress.progress.bytesTotal}
          />
        </div>
      )}

      {fatalError && (
        <div className="nx-mt-4 nx-rounded-lg nx-border nx-border-red-200 nx-bg-red-50 nx-p-4 nx-text-sm dark:nx-border-red-900/50 dark:nx-bg-red-950/30">
          <span className="nx-font-semibold">Error:</span> {fatalError}
        </div>
      )}
    </section>
  );
}
