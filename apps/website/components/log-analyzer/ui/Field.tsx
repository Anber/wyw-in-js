import * as React from 'react';

import { cx } from '../utils';

export type FieldProps = {
  children: React.ReactNode;
  className?: string;
  hint?: React.ReactNode;
  label: React.ReactNode;
  labelClassName?: string;
};

export function Field({
  children,
  className,
  hint,
  label,
  labelClassName,
}: FieldProps) {
  return (
    <label className={cx('nx-grid nx-gap-1', className)}>
      <span
        className={
          labelClassName ??
          'nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400'
        }
      >
        {label}
      </span>
      {children}
      {hint ? (
        <span className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

