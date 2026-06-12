import type {
  BabelFileResult,
  PluginItem,
  TransformOptions,
} from '@babel/core';
import type { File } from '@babel/types';

import type { StrictOptions } from '@wyw-in-js/shared';

import type { Core } from '../babel';
import { buildOptions } from '../options/buildOptions';
import dynamicImportPlugin from '../plugins/dynamic-import';
import requireFallbackPlugin from '../plugins/require-fallback';
import preevalPlugin from '../plugins/preeval';
import type { EventEmitter } from '../utils/EventEmitter';
import { getPluginKey } from '../utils/getPluginKey';

const hasKeyInList = (plugin: PluginItem, list: string[]): boolean => {
  const pluginKey = getPluginKey(plugin);
  return pluginKey ? list.some((i) => pluginKey.includes(i)) : false;
};

const DYNAMIC_IMPORT_RE = /\bimport(?:\s|\/\*[\s\S]*?\*\/)*\(/;
const REQUIRE_CALL_RE = /\brequire(?:\s|\/\*[\s\S]*?\*\/)*\(/;

export const maybeNeedsDynamicImportPlugin = (code: string): boolean =>
  DYNAMIC_IMPORT_RE.test(code);

export const maybeNeedsRequireFallbackPlugin = (code: string): boolean =>
  REQUIRE_CALL_RE.test(code);

export function runPreevalStage(
  babel: Core,
  evalConfig: TransformOptions,
  pluginOptions: StrictOptions,
  code: string,
  originalAst: File,
  eventEmitter: EventEmitter
): BabelFileResult {
  const preShakePlugins =
    evalConfig.plugins?.filter((i) =>
      hasKeyInList(i, pluginOptions.highPriorityPlugins)
    ) ?? [];
  const needsDynamicImportPlugin = maybeNeedsDynamicImportPlugin(code);
  const needsRequireFallbackPlugin = maybeNeedsRequireFallbackPlugin(code);

  const plugins = [
    ...preShakePlugins,
    [
      preevalPlugin,
      {
        ...pluginOptions,
        eventEmitter,
      },
    ],
    ...(needsDynamicImportPlugin ? [dynamicImportPlugin] : []),
    ...(needsRequireFallbackPlugin ? [requireFallbackPlugin] : []),
    ...(evalConfig.plugins ?? []).filter(
      (i) => !hasKeyInList(i, pluginOptions.highPriorityPlugins)
    ),
  ];

  const transformConfig = buildOptions({
    envName: 'wyw-in-js',
    ...evalConfig,
    plugins,
  });

  const result = babel.transformFromAstSync(originalAst, code, transformConfig);

  if (!result || !result.ast?.program) {
    throw new Error('Babel transform failed');
  }

  return result;
}
