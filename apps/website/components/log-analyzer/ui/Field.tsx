import * as React from 'react';

import { cx } from '../utils';

export type FieldControlProps = {
  describedBy?: string;
  id: string;
};

export type FieldProps = {
  children: React.ReactNode | ((props: FieldControlProps) => React.ReactNode);
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
  const autoId = React.useId();
  const childId =
    React.isValidElement(children) && typeof children.props.id === 'string'
      ? (children.props.id as string)
      : autoId;

  const hintId = hint ? `${childId}-hint` : undefined;
  const canAssociateLabel =
    typeof children === 'function' || React.isValidElement(children);

  let control: React.ReactNode;
  if (typeof children === 'function') {
    control = children({ id: childId, describedBy: hintId });
  } else if (React.isValidElement(children)) {
    control = React.cloneElement(children, {
      ...(children.props.id ? {} : { id: childId }),
      ...(hintId
        ? {
            'aria-describedby': children.props['aria-describedby']
              ? `${children.props['aria-describedby']} ${hintId}`
              : hintId,
          }
        : {}),
    });
  } else {
    control = children;
  }

  return (
    <div className={cx('nx-grid nx-gap-1', className)}>
      <label
        {...(canAssociateLabel ? { htmlFor: childId } : {})}
        className={
          labelClassName ??
          'nx-text-xs nx-font-semibold nx-text-neutral-600 dark:nx-text-neutral-400'
        }
      >
        {label}
      </label>
      {control}
      {hint ? (
        <div
          id={hintId}
          className="nx-text-xs nx-text-neutral-600 dark:nx-text-neutral-400"
        >
          {hint}
        </div>
      ) : null}
    </div>
  );
}
