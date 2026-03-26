import type { TransformOptions, PluginItem } from '@babel/core';
import type { File } from '@babel/types';

import type { Evaluator, EvaluatorConfig } from '@wyw-in-js/shared';

import shakerPlugin from './plugins/shaker';
import { hasShakerMetadata } from './utils/ShakerMetadata';
import { getPluginKey } from './utils/getPluginKey';

const hasKeyInList = (plugin: PluginItem, list: string[]): boolean => {
  const pluginKey = getPluginKey(plugin);
  return pluginKey ? list.some((i) => pluginKey.includes(i)) : false;
};

const isCommonJSPlugin = (plugin: PluginItem): boolean =>
  getPluginKey(plugin) === 'transform-modules-commonjs';

const safeResolve = (id: string, paths: (string | null)[]): string | null => {
  try {
    return require.resolve(id, {
      paths: paths.filter((i) => i !== null) as string[],
    });
  } catch {
    return null;
  }
};

const ensureTypescriptPlugin = (
  plugins: PluginItem[],
  evalConfig: TransformOptions
) => {
  if (
    !evalConfig.filename?.endsWith('.ts') &&
    !evalConfig.filename?.endsWith('.tsx') &&
    !evalConfig.filename?.endsWith('.mts') &&
    !evalConfig.filename?.endsWith('.cts')
  ) {
    return;
  }

  const hasTypescriptPlugin = plugins.some(
    (i) => getPluginKey(i) === 'transform-typescript'
  );

  if (hasTypescriptPlugin) {
    return;
  }

  const preset = safeResolve('@babel/preset-typescript', [evalConfig.filename]);
  const plugin = safeResolve('@babel/plugin-transform-typescript', [
    evalConfig.filename,
    preset,
  ]);

  if (plugin) {
    plugins.push([plugin, { allowDeclareFields: true }]);
  }
};

const createShakerPlugins = (
  evalConfig: TransformOptions,
  config: EvaluatorConfig,
  includeCommonJS: boolean
): PluginItem[] => {
  const { highPriorityPlugins, ...shakerConfig } = config;
  const preShakePlugins =
    evalConfig.plugins?.filter((i) => hasKeyInList(i, highPriorityPlugins)) ??
    [];

  const plugins: PluginItem[] = [
    ...preShakePlugins,
    [shakerPlugin, shakerConfig],
    ...(evalConfig.plugins ?? []).filter(
      (i) => !hasKeyInList(i, highPriorityPlugins) && !isCommonJSPlugin(i)
    ),
  ];

  ensureTypescriptPlugin(plugins, evalConfig);

  if (includeCommonJS) {
    plugins.push(require.resolve('@babel/plugin-transform-modules-commonjs'));
  }

  return plugins;
};

type ShakerStageResult = [
  ast: File,
  code: string,
  imports: Map<string, string[]> | null,
];

export const shakeToESM = (
  evalConfig: TransformOptions,
  ast: File,
  code: string,
  config: EvaluatorConfig,
  babel: Parameters<Evaluator>[4]
): ShakerStageResult => {
  const transformed = babel.transformFromAstSync(ast, code, {
    ...evalConfig,
    ast: true,
    caller: {
      name: 'wyw-in-js',
    },
    plugins: createShakerPlugins(evalConfig, config, false),
  });

  if (!transformed || !hasShakerMetadata(transformed.metadata)) {
    throw new Error(`${evalConfig.filename} has no shaker metadata`);
  }

  return [
    transformed.ast!,
    transformed.code ?? '',
    transformed.metadata.wywEvaluator.imports,
  ];
};

export const emitCommonJS = (
  evalConfig: TransformOptions,
  ast: File,
  code: string,
  babel: Parameters<Evaluator>[4]
): [ast: File, code: string] => {
  const transformed = babel.transformFromAstSync(ast, code, {
    ...evalConfig,
    ast: true,
    caller: {
      name: 'wyw-in-js',
    },
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  });

  if (!transformed?.ast) {
    throw new Error('Babel transform failed');
  }

  return [transformed.ast, transformed.code ?? ''];
};

export const shaker: Evaluator = (evalConfig, ast, code, config, babel) => {
  const [esmAst, esmCode, imports] = shakeToESM(
    evalConfig,
    ast,
    code,
    config,
    babel
  );
  const [, commonJSCode] = emitCommonJS(evalConfig, esmAst, esmCode, babel);

  return [esmAst, commonJSCode, imports];
};

export default shaker;
