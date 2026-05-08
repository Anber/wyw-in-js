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

export const getStaticStrategyFailure = (
  filename: string,
  dependencyNames: Iterable<string>
): Error =>
  new Error(
    `[wyw-in-js] eval.strategy: "static" cannot fall back to the build-time evaluator for ${filename}. ` +
      `Unresolved values: ${[...dependencyNames].join(', ')}.`
  );

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
