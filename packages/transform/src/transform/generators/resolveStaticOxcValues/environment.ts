/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { isAbsolute, relative } from 'path';

import type { Program } from 'oxc-parser';

import { parseOxcProgram } from '../../../utils/oxc/parse';
import { stripQueryAndHash } from '../../../utils/parseRequest';
import type { ITransformAction } from '../../types';
import type { StaticResolveDebugEvent } from './types';

export const isInsideRoot = (filename: string, root: string): boolean => {
  const relativePath = relative(root, filename);
  return (
    relativePath === '' ||
    (!!relativePath &&
      !relativePath.startsWith('..') &&
      !isAbsolute(relativePath))
  );
};

export const nodeModulesPattern = /[\\/]node_modules[\\/]/;

export const isLocalStaticMetadataFile = (
  filename: string,
  root: string
): boolean => {
  const strippedFilename = stripQueryAndHash(filename);
  if (isInsideRoot(strippedFilename, root)) {
    return true;
  }

  return (
    isAbsolute(strippedFilename) && !nodeModulesPattern.test(strippedFilename)
  );
};

export const isEnvDisabled = (value: string): boolean =>
  value === '0' || value === 'false' || value === 'no' || value === 'off';

export const getEvalStrategy = (action: ITransformAction) =>
  action.services.options.pluginOptions.eval?.strategy ?? 'execute';

export type UnresolvedValueDetail = {
  /** Original source text of the interpolation, e.g. `theme.warm.light`. */
  source?: string;
  /** Module the value was imported from, when it originates from an import. */
  importedFrom?: string;
};

const formatUnresolvedValue = (
  name: string,
  detail: UnresolvedValueDetail | undefined
): string => {
  if (!detail?.source || detail.source === name) {
    return detail?.importedFrom
      ? `${name} (imported from ${detail.importedFrom})`
      : name;
  }

  const origin = detail.importedFrom
    ? `, imported from ${detail.importedFrom}`
    : '';
  return `${name} (\`${detail.source}\`${origin})`;
};

export const getStaticStrategyFailure = (
  filename: string,
  dependencyNames: Iterable<string>,
  details?: ReadonlyMap<string, UnresolvedValueDetail>
): Error => {
  const formatted = [...dependencyNames].map((name) =>
    formatUnresolvedValue(name, details?.get(name))
  );

  return new Error(
    `[wyw-in-js] eval.strategy: "static" cannot fall back to the build-time evaluator for ${filename}.\n` +
      `These interpolated values could not be resolved at build time:\n${formatted
        .map((line) => `  - ${line}`)
        .join(
          '\n'
        )}\n\nThey reference runtime-only values (function calls, mutated objects, ` +
      `non-serializable data, or modules the static evaluator skips). ` +
      `Either make them statically analyzable, or relax eval.strategy from "static" to "hybrid".`
  );
};

export const debugStaticResolve = (
  action: ITransformAction,
  event: StaticResolveDebugEvent
): void => {
  const labels = Object.fromEntries(
    Object.entries({
      ...event,
      type: 'staticResolve',
    }).filter(([, value]) => value !== undefined)
  );

  action.services.eventEmitter.single(labels);
};

export const parseProgram = (code: string, filename: string): Program =>
  parseOxcProgram(code, filename, 'unambiguous');

export const getStaticBindings = (
  action: ITransformAction
): Record<string, Record<string, unknown>> | undefined =>
  action.services.options.pluginOptions?.staticBindings;
