import * as React from 'react';

import styles from '../LogAnalyzer.module.css';

import { cx } from '../utils';

export type ButtonVariant = 'primary' | 'secondary';

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export function Button({
  className,
  type = 'button',
  variant = 'secondary',
  ...rest
}: ButtonProps) {
  return (
    <button
      // eslint-disable-next-line react/button-has-type
      type={type}
      className={cx(
        styles.button,
        variant === 'primary' ? styles.buttonPrimary : styles.buttonSecondary,
        className
      )}
      {...rest}
    />
  );
}

export type TabButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
};

export function TabButton({
  active = false,
  className,
  type = 'button',
  ...rest
}: TabButtonProps) {
  return (
    <button
      // eslint-disable-next-line react/button-has-type
      type={type}
      className={cx(styles.tabButton, active && styles.tabButtonActive, className)}
      {...rest}
    />
  );
}

