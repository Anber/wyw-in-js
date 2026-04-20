import * as React from 'react';

import styles from '../LogAnalyzer.module.css';

import { cx } from '../utils';

export type TruncateCellProps = {
  as?: 'code' | 'span';
  className?: string;
  startEllipsis?: boolean;
  title?: string;
  value: string;
};

export function TruncateCell({
  as = 'code',
  className,
  startEllipsis = false,
  title,
  value,
}: TruncateCellProps) {
  const Component = as;

  return (
    <Component
      className={cx(
        styles.cellTruncate,
        startEllipsis && styles.cellTruncateStart,
        className
      )}
      title={title ?? value}
    >
      {startEllipsis ? <span>{value}</span> : value}
    </Component>
  );
}
