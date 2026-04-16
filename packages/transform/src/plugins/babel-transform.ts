import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import type { BabelFile, PluginObj } from '@babel/core';

import { logger } from '@wyw-in-js/shared';

import type { Core } from '../babel';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import type { IPluginState, PluginOptions } from '../types';
import { collector } from './collector';
import {
  encodeGlobals,
  deserializeValue,
  type SerializedValue,
} from '../eval/serialize';

type SyncEvalPayload = {
  filename: string;
  root?: string;
  code: string;
  inputSourceMap?: unknown;
  pluginOptions: Partial<PluginOptions>;
  inlineEvalGlobals?: unknown;
};

const debug = logger.extend('babel-transform');
const buildRunnerPath = () => {
  const jsPath = fileURLToPath(new URL('../babel/sync-eval-runner.js', import.meta.url));
  if (existsSync(jsPath)) {
    return jsPath;
  }

  return fileURLToPath(new URL('../babel/sync-eval-runner.ts', import.meta.url));
};

const runnerPath = buildRunnerPath();

const nodeBinary =
  runnerPath.endsWith('.ts') && process.execPath.includes('bun')
    ? process.execPath
    : process.env.WYW_NODE_BINARY ||
      (process.execPath.includes('bun') ? 'node' : process.execPath);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const getObjectTypeName = (value: object): string => {
  const { constructor } = value as { constructor?: { name?: unknown } };
  if (
    constructor &&
    typeof constructor.name === 'string' &&
    constructor.name.length > 0
  ) {
    return constructor.name;
  }

  const tag = Object.prototype.toString.call(value);
  return tag.slice(8, -1) || 'Object';
};

const formatOptionPath = (path: Array<string | number>): string =>
  path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') {
      return `${acc}[${segment}]`;
    }

    if (/^[A-Za-z_$][\w$]*$/u.test(segment)) {
      return `${acc}.${segment}`;
    }

    return `${acc}[${JSON.stringify(segment)}]`;
  }, 'options');

const throwNonSerializableOption = (
  path: Array<string | number>,
  reason: string
): never => {
  throw new Error(
    `[wyw-in-js] Babel preset option ${formatOptionPath(path)} is not serializable (${reason}). ` +
      'Move it into a config file or use the async transform() API.'
  );
};

const validateSerializableValue = (
  value: unknown,
  path: Array<string | number>
): void => {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return;
  }

  if (typeof value === 'function') {
    throwNonSerializableOption(path, 'Function');
  }

  if (typeof value === 'symbol') {
    throwNonSerializableOption(path, 'Symbol');
  }

  if (typeof value === 'bigint') {
    throwNonSerializableOption(path, 'BigInt');
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateSerializableValue(item, [...path, index])
    );
    return;
  }

  if (isPlainObject(value)) {
    Object.entries(value).forEach(([key, item]) =>
      validateSerializableValue(item, [...path, key])
    );
    return;
  }

  throwNonSerializableOption(path, getObjectTypeName(value));
};

const stringifyPayload = (payload: SyncEvalPayload) => {
  validateSerializableValue(payload.inputSourceMap, ['inputSourceMap']);
  validateSerializableValue(payload.pluginOptions, ['pluginOptions']);
  return JSON.stringify(payload);
};

const buildEvalPayload = (
  file: BabelFile,
  options: Partial<PluginOptions>
): SyncEvalPayload => {
  const filename = file.opts.filename!;
  const evalOptions = options.eval ?? {};
  const inlineEvalGlobals =
    evalOptions.globals === undefined ? undefined : encodeGlobals(evalOptions.globals);
  const nextEvalOptions =
    'globals' in evalOptions
      ? Object.fromEntries(
          Object.entries(evalOptions).filter(([key]) => key !== 'globals')
        )
      : evalOptions;

  const pluginOptionsForChild: Partial<PluginOptions> = {
    ...options,
    eval: nextEvalOptions,
  };

  if (
    pluginOptionsForChild.eval &&
    Object.keys(pluginOptionsForChild.eval).length === 0
  ) {
    delete pluginOptionsForChild.eval;
  }

  return {
    filename,
    root: file.opts.root ?? undefined,
    code: file.code ?? '',
    inputSourceMap: file.opts.inputSourceMap ?? undefined,
    pluginOptions: pluginOptionsForChild,
    inlineEvalGlobals,
  };
};

const runSyncEval = (payload: SyncEvalPayload) => {
  let input: string;
  try {
    input = stringifyPayload(payload);
  } catch (error) {
    throw new Error(
      `[wyw-in-js] Failed to serialize babel preset options: ${String(error)}`
    );
  }

  const result = spawnSync(nodeBinary, [runnerPath], {
    input,
    encoding: 'utf8',
    cwd: payload.root ?? process.cwd(),
    env: {
      ...process.env,
      WYW_EVAL_BABEL_SYNC: '1',
      NODE_NO_WARNINGS: '1',
    },
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `[wyw-in-js] Babel preset sync eval failed:\n${result.stderr ?? ''}`
    );
  }

  const output = result.stdout ? JSON.parse(result.stdout) : {};
  const serializedValues = output.values as
    | Record<string, SerializedValue>
    | null
    | undefined;

  if (!serializedValues) {
    return null;
  }

  const values = new Map<string, unknown>();
  Object.entries(serializedValues).forEach(([key, serialized]) => {
    values.set(key, deserializeValue(serialized));
  });

  return values;
};

export default function babelTransform(
  _babel: Core,
  options: Partial<PluginOptions>
): PluginObj<IPluginState> {
  return {
    name: '@wyw-in-js/transform/babel-transform',
    pre(file: BabelFile) {
      debug('start %s', file.opts.filename);

      const pluginOptions = loadWywOptions(options);
      const payload = buildEvalPayload(file, options);
      const values = runSyncEval(payload);

      if (!values) {
        return;
      }

      const processors = collector(file, pluginOptions, values);

      if (processors.length === 0) {
        return;
      }

      this.file.metadata.wywInJS = {
        processors,
        replacements: [],
        rules: {},
        dependencies: [],
      };
    },
    visitor: {},
    post(file: BabelFile) {
      debug('end %s', file.opts.filename);
    },
  };
}
