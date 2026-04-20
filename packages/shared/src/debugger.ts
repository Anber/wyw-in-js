export type Debugger = {
  (formatter: unknown, ...args: unknown[]): void;
  color: string;
  destroy: () => boolean;
  diff: number;
  enabled: boolean;
  extend: (namespace: string, delimiter?: string) => Debugger;
  log: (...args: unknown[]) => unknown;
  namespace: string;
};
