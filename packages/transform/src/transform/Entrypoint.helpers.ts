import { readFileSync } from 'fs';
import { dirname, extname, isAbsolute } from 'path';

import type { TransformOptions, PluginItem } from '@babel/core';
import type { File } from '@babel/types';

import type {
  Debugger,
  EvalRule,
  Evaluator,
  StrictOptions,
} from '@wyw-in-js/shared';
import { logger, isFeatureEnabled } from '@wyw-in-js/shared';

import type { Core } from '../babel';
import { buildOptions } from '../options/buildOptions';
import { loadBabelOptions } from '../options/loadBabelOptions';
import type { ParentEntrypoint } from '../types';
import { getFileIdx } from '../utils/getFileIdx';
import { getPluginKey } from '../utils/getPluginKey';

import type { IEntrypointCode, IIgnoredEntrypoint } from './Entrypoint.types';
import type { Services } from './types';
import { stripQueryAndHash } from '../utils/parseRequest';

export function getMatchedRule(
  rules: EvalRule[],
  filename: string,
  code: string
): EvalRule {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (!rule.test) {
      return rule;
    }

    if (typeof rule.test === 'function' && rule.test(filename, code)) {
      return rule;
    }

    if (rule.test instanceof RegExp && rule.test.test(filename)) {
      return rule;
    }
  }

  return { action: 'ignore' };
}

export function parseFile(
  babel: Core,
  filename: string,
  originalCode: string,
  parseConfig: TransformOptions
): File {
  const log = logger.extend('transform:parse').extend(getFileIdx(filename));

  const parseResult = babel.parseSync(originalCode, parseConfig);
  if (!parseResult) {
    throw new Error(`Failed to parse ${filename}`);
  }

  log('stage-1', `${filename} has been parsed`);

  return parseResult;
}

const isModuleResolver = (plugin: PluginItem) => {
  const key = getPluginKey(plugin);
  if (!key) return false;

  if (['module-resolver', 'babel-plugin-module-resolver'].includes(key)) {
    return true;
  }

  return /([\\/])babel-plugin-module-resolver\1/.test(key);
};

let moduleResolverWarned = false;

const normalizeBabelKey = (key: string) => key.replace(/\\/g, '/');

const isBabelPresetTypescript = (key: string) => {
  const normalized = normalizeBabelKey(key);

  if (normalized === 'typescript') return true;
  return normalized.includes('preset-typescript');
};

const isBabelTransformTypescriptPlugin = (key: string) => {
  const normalized = normalizeBabelKey(key);

  if (normalized === 'transform-typescript') return true;
  return normalized.includes('plugin-transform-typescript');
};

const withAllowDeclareFields = (item: PluginItem): PluginItem => {
  if (!Array.isArray(item)) {
    return [item, { allowDeclareFields: true }];
  }

  const [target, rawOptions, ...rest] = item;
  const options =
    typeof rawOptions === 'object' &&
    rawOptions !== null &&
    !Array.isArray(rawOptions)
      ? rawOptions
      : {};

  if ('allowDeclareFields' in options) {
    return item;
  }

  return [target, { ...options, allowDeclareFields: true }, ...rest];
};

type AllowDeclareFieldsPatchScope = 'top' | 'env' | 'override';

const ensureAllowDeclareFieldsInBabelOptions = (
  babelOptions: TransformOptions,
  scope: AllowDeclareFieldsPatchScope = 'top'
): TransformOptions => {
  let presetsChanged = false;
  let pluginsChanged = false;
  let overridesChanged = false;
  let envChanged = false;

  const presets = babelOptions.presets?.map((item) => {
    const key = getPluginKey(item);
    if (!key || !isBabelPresetTypescript(key)) {
      return item;
    }

    presetsChanged = true;
    return withAllowDeclareFields(item);
  });

  const plugins = babelOptions.plugins?.map((item) => {
    const key = getPluginKey(item);
    if (!key || !isBabelTransformTypescriptPlugin(key)) {
      return item;
    }

    pluginsChanged = true;
    return withAllowDeclareFields(item);
  });

  const { overrides: baseOverrides } = babelOptions;
  let overrides = baseOverrides;
  if (scope === 'top' && baseOverrides) {
    const patchedOverrides = baseOverrides.map((override) =>
      ensureAllowDeclareFieldsInBabelOptions(
        override as TransformOptions,
        'override'
      )
    );

    if (
      patchedOverrides.some(
        (patchedOverride, idx) => patchedOverride !== baseOverrides[idx]
      )
    ) {
      overridesChanged = true;
      overrides = patchedOverrides;
    }
  }

  const { env: baseEnv } = babelOptions;
  let env = baseEnv;
  if (scope === 'top' && baseEnv) {
    const entries = Object.entries(baseEnv);
    const patchedEntries = entries.map(([envName, envOptions]) => [
      envName,
      envOptions
        ? ensureAllowDeclareFieldsInBabelOptions(envOptions, 'env')
        : envOptions,
    ]) as Array<[string, TransformOptions | null | undefined]>;

    if (
      patchedEntries.some(([, patched], idx) => patched !== entries[idx][1])
    ) {
      envChanged = true;
      env = Object.fromEntries(patchedEntries);
    }
  }

  if (!presetsChanged && !pluginsChanged && !overridesChanged && !envChanged) {
    return babelOptions;
  }

  const next: TransformOptions = { ...babelOptions };
  if (presetsChanged) next.presets = presets;
  if (pluginsChanged) next.plugins = plugins;
  if (overridesChanged) next.overrides = overrides;
  if (envChanged) next.env = env;

  return next;
};

function buildConfigs(
  services: Services,
  name: string,
  pluginOptions: StrictOptions,
  babelOptions: TransformOptions | undefined
): {
  evalConfig: TransformOptions;
  parseConfig: TransformOptions;
} {
  const { babel, options } = services;

  const commonOptions = {
    ast: true,
    filename: name,
    inputSourceMap: options.inputSourceMap,
    root: options.root,
    sourceFileName: name,
    sourceMaps: true,
  };

  const isTypescriptFile =
    name.endsWith('.ts') ||
    name.endsWith('.tsx') ||
    name.endsWith('.mts') ||
    name.endsWith('.cts');

  let rawConfig = buildOptions(
    pluginOptions?.babelOptions,
    babelOptions,
    commonOptions
  );

  if (isTypescriptFile) {
    rawConfig = ensureAllowDeclareFieldsInBabelOptions(rawConfig);
  }

  const useBabelConfigs = isFeatureEnabled(
    pluginOptions.features,
    'useBabelConfigs',
    name
  );

  if (!useBabelConfigs) {
    rawConfig = {
      ...rawConfig,
      configFile: false,
    };
  }

  const parseConfig = loadBabelOptions(babel, name, {
    babelrc: useBabelConfigs,
    ...rawConfig,
  });

  const parseHasModuleResolver = parseConfig.plugins?.some(isModuleResolver);
  const rawHasModuleResolver = rawConfig.plugins?.some(isModuleResolver);

  if (parseHasModuleResolver && !rawHasModuleResolver) {
    if (!moduleResolverWarned) {
      // eslint-disable-next-line no-console
      console.warn(
        `[wyw-in-js] ${name} has a module-resolver plugin in its babelrc, but it is not present ` +
          `in the babelOptions for the wyw-in-js plugin. This works for now but will be an error in the future. ` +
          `Please add the module-resolver plugin to the babelOptions for the wyw-in-js plugin.`
      );

      moduleResolverWarned = true;
    }

    rawConfig = {
      ...rawConfig,
      plugins: [
        ...(parseConfig.plugins?.filter((plugin) => isModuleResolver(plugin)) ??
          []),
        ...(rawConfig.plugins ?? []),
      ],
    };
  }

  const evalConfig = loadBabelOptions(babel, name, {
    babelrc: false,
    ...rawConfig,
  });

  return {
    evalConfig,
    parseConfig,
  };
}

export function loadAndParse(
  services: Services,
  name: string,
  loadedCode: string | undefined,
  log: Debugger
): IEntrypointCode | IIgnoredEntrypoint {
  const {
    babel,
    eventEmitter,
    options: { pluginOptions },
  } = services;

  const filename = stripQueryAndHash(name);
  const extension = extname(filename);

  if (!pluginOptions.extensions.includes(extension)) {
    log(
      '[createEntrypoint] %s is ignored. If you want it to be processed, you should add \'%s\' to the "extensions" option.',
      filename,
      extension
    );

    return {
      code: isAbsolute(filename) ? loadedCode : '',
      evaluator: 'ignored',
      reason: 'extension',
    };
  }

  let code = loadedCode;

  if (code === undefined) {
    const cachedEntrypoint = services.cache.get('entrypoints', name);
    if (
      cachedEntrypoint &&
      'initialCode' in cachedEntrypoint &&
      typeof cachedEntrypoint.initialCode === 'string'
    ) {
      code = cachedEntrypoint.initialCode;
    }
  }

  code ??= readFileSync(filename, 'utf-8');

  const { action, babelOptions } = getMatchedRule(
    pluginOptions.rules,
    filename,
    code
  );

  let ast: File | undefined;

  const { evalConfig, parseConfig } = buildConfigs(
    services,
    filename,
    pluginOptions,
    babelOptions
  );

  const getOrParse = () => {
    if (ast) return ast;
    ast = eventEmitter.perf('parseFile', () =>
      parseFile(babel, name, code, parseConfig)
    );

    return ast;
  };

  if (action === 'ignore') {
    log('[createEntrypoint] %s is ignored by rule', name);
    return {
      get ast() {
        return getOrParse();
      },
      code,
      evaluator: 'ignored',
      reason: 'rule',
    };
  }

  const evaluator: Evaluator =
    typeof action === 'function'
      ? action
      : require(
          require.resolve(action, {
            paths: [dirname(filename)],
          })
        ).default;

  return {
    get ast() {
      return getOrParse();
    },
    code,
    evaluator,
    evalConfig,
  };
}

export function getStack(entrypoint: ParentEntrypoint) {
  if (!entrypoint) return [];

  const stack = [entrypoint.name];

  let { parents } = entrypoint;
  while (parents.length) {
    stack.push(parents[0].name);
    parents = parents[0].parents;
  }

  return stack;
}

export function mergeOnly(a: string[], b: string[]) {
  const result = new Set(a);
  b.forEach((item) => result.add(item));
  return [...result].filter((i) => i).sort();
}

export const isSuperSet = <T>(a: (T | '*')[], b: (T | '*')[]) => {
  if (a.includes('*')) return true;
  if (b.length === 0) return true;
  const aSet = new Set(a);
  return b.every((item) => aSet.has(item));
};
