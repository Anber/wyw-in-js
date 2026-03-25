import { spawnSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

import type { BabelFile, PluginObj } from '@babel/core';

import { logger } from '@wyw-in-js/shared';

import type { Core } from '../babel';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import type { IPluginState, PluginOptions } from '../types';
import { collector } from './collector';
import {
  deserializeValue,
  encodeGlobals,
  type SerializedValue,
} from '../eval/serialize';

type SyncEvalPayload = {
  filename: string;
  root?: string;
  code: string;
  inputSourceMap?: unknown;
  pluginOptions: Partial<PluginOptions>;
};

const debug = logger.extend('babel-transform');
const runnerPath = fileURLToPath(
  new URL('../babel/sync-eval-runner.js', import.meta.url)
);

const nodeBinary =
  process.env.WYW_NODE_BINARY ||
  (process.execPath.includes('bun') ? 'node' : process.execPath);

const stringifyPayload = (payload: SyncEvalPayload) =>
  JSON.stringify(payload, (_key, value) => {
    if (typeof value === 'function') {
      throw new Error(
        '[wyw-in-js] Babel preset does not support non-serializable options. Move them into a config file or use the async transform() API.'
      );
    }
    if (typeof value === 'symbol') {
      throw new Error(
        '[wyw-in-js] Babel preset does not support Symbol values in options.'
      );
    }
    return value;
  });

const buildEvalPayload = (
  file: BabelFile,
  pluginOptions: ReturnType<typeof loadWywOptions>
): SyncEvalPayload => {
  const filename = file.opts.filename!;
  const evalOptions = pluginOptions.eval ?? {};
  const baseGlobals = evalOptions.globals ?? {};
  const withFilename = {
    ...baseGlobals,
    __filename: filename,
    __dirname: dirname(filename),
  };
  const finalGlobals = pluginOptions.overrideContext
    ? pluginOptions.overrideContext(withFilename, filename)
    : withFilename;
  const encodedGlobals = encodeGlobals(finalGlobals) as Record<string, unknown>;

  const evalOptionsForChild = {
    ...evalOptions,
    globals: encodedGlobals,
  };

  const pluginOptionsForChild: Partial<PluginOptions> = {
    ...pluginOptions,
    eval: evalOptionsForChild,
  };

  delete pluginOptionsForChild.overrideContext;
  delete pluginOptionsForChild.tagResolver;
  if (typeof pluginOptionsForChild.classNameSlug === 'function') {
    delete pluginOptionsForChild.classNameSlug;
  }
  if (typeof pluginOptionsForChild.variableNameSlug === 'function') {
    delete pluginOptionsForChild.variableNameSlug;
  }

  return {
    filename,
    root: file.opts.root ?? undefined,
    code: file.code ?? '',
    inputSourceMap: file.opts.inputSourceMap ?? undefined,
    pluginOptions: pluginOptionsForChild,
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
      const payload = buildEvalPayload(file, pluginOptions);
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
