import type { ValueCache } from '@wyw-in-js/processor-utils';
import { isDeepStrictEqual } from 'util';

export type PrevalPayloadSource = 'eval' | 'static';

export type PrevalPayload = {
  dependencies: string[];
  sources: Map<string, PrevalPayloadSource>;
  values: ValueCache;
};

export type CreatePrevalPayloadInput = {
  emitWarning?: (message: string) => void;
  evalDependencies?: readonly string[];
  evalValues?: Map<string, unknown> | null;
  filename: string;
  staticDependencies?: readonly string[];
  staticValues?: Map<string, unknown> | null;
};

const addUnique = <T>(target: T[], value: T): void => {
  if (!target.includes(value)) {
    target.push(value);
  }
};

const emitProductionWarning = (
  emitWarning: ((message: string) => void) | undefined,
  message: string
): void => {
  if (emitWarning) {
    emitWarning(message);
    return;
  }

  // eslint-disable-next-line no-console
  console.warn(message);
};

const handleDisagreement = (
  filename: string,
  name: string,
  evalValue: unknown,
  staticValue: unknown,
  emitWarning: ((message: string) => void) | undefined
): void => {
  const message = [
    `[wyw-in-js] PrevalPayload disagreement for "${name}" in ${filename}.`,
    'Static and evaluated values differ; keeping the static value to preserve baseline precedence.',
    `eval: ${String(evalValue)}`,
    `static: ${String(staticValue)}`,
  ].join(' ');

  if (process.env.NODE_ENV === 'production') {
    emitProductionWarning(emitWarning, message);
    return;
  }

  throw new Error(message);
};

export const createPrevalPayload = ({
  emitWarning,
  evalDependencies = [],
  evalValues,
  filename,
  staticDependencies = [],
  staticValues,
}: CreatePrevalPayloadInput): PrevalPayload => {
  const dependencies: string[] = [];
  const sources = new Map<string, PrevalPayloadSource>();
  const values: ValueCache = new Map();

  evalDependencies.forEach((dependency) => addUnique(dependencies, dependency));
  staticDependencies.forEach((dependency) =>
    addUnique(dependencies, dependency)
  );

  evalValues?.forEach((value, name) => {
    values.set(name, value);
    sources.set(String(name), 'eval');
  });

  staticValues?.forEach((value, name) => {
    if (values.has(name) && !isDeepStrictEqual(values.get(name), value)) {
      handleDisagreement(
        filename,
        String(name),
        values.get(name),
        value,
        emitWarning
      );
    }

    values.set(name, value);
    sources.set(String(name), 'static');
  });

  return {
    dependencies,
    sources,
    values,
  };
};
