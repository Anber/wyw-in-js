import genericDebug from 'debug';

import type { Debugger } from './debugger';

const BASE_NAMESPACE = 'wyw-in-js';

export const logger: Debugger = genericDebug(BASE_NAMESPACE);

const loggers = new Map<string, Debugger>();

function gerOrCreate(namespace: string | null | undefined): Debugger {
  if (!namespace) return logger;
  const lastIndexOf = namespace.lastIndexOf(':');
  if (!loggers.has(namespace)) {
    loggers.set(
      namespace,
      gerOrCreate(namespace.substring(0, lastIndexOf)).extend(
        namespace.substring(lastIndexOf + 1)
      )
    );
  }

  return loggers.get(namespace)!;
}

genericDebug.formatters.r = (
  ref: string | { namespace: string; text?: string }
) => {
  const namespace = typeof ref === 'string' ? ref : ref.namespace;
  const text = typeof ref === 'string' ? namespace : ref.text ?? namespace;
  const color = parseInt(gerOrCreate(namespace).color, 10);
  const colorCode = `\u001B[3${color < 8 ? color : `8;5;${color}`}`;
  return `${colorCode};1m${text}\u001B[0m`;
};

genericDebug.formatters.f = function f(fn: () => unknown) {
  return JSON.stringify(fn());
};

export function enableDebug(namespace = `${BASE_NAMESPACE}:*`) {
  genericDebug.enable(namespace);
}
