import { readFileSync } from 'fs';

import type { RawSourceMap } from 'source-map';

import { asyncResolveFallback } from '@wyw-in-js/shared';
import type { ValueCache } from '@wyw-in-js/processor-utils';

import type { PluginOptions } from '../types';
import { TransformCacheCollection } from '../cache';
import { disposeEvalBroker } from '../eval/broker';
import { transform } from '../transform';
import type { ICollectAction, SyncScenarioForAction } from '../transform/types';
import { decodeGlobals, serializeValue } from '../eval/serialize';

type SyncEvalPayload = {
  filename: string;
  root?: string;
  code: string;
  inputSourceMap?: unknown;
  pluginOptions: Partial<PluginOptions>;
  inlineEvalGlobals?: unknown;
};

const readStdin = () => {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};

const fail = (message: string) => {
  // eslint-disable-next-line no-console
  console.error(message);
  process.exit(1);
};

const rawInput = readStdin();
if (!rawInput.trim()) {
  fail('[wyw-in-js] babel sync runner: empty input');
}

let payload!: SyncEvalPayload;
try {
  payload = JSON.parse(rawInput) as SyncEvalPayload;
} catch (error) {
  fail(
    `[wyw-in-js] babel sync runner: failed to parse input: ${String(error)}`
  );
}

const { filename, root, code, inputSourceMap, pluginOptions, inlineEvalGlobals } =
  payload;
const normalizedInputSourceMap = inputSourceMap as RawSourceMap | undefined;
const pluginOptionsForTransform: Partial<PluginOptions> = { ...pluginOptions };

if (inlineEvalGlobals !== undefined) {
  pluginOptionsForTransform.eval = {
    ...(pluginOptionsForTransform.eval ?? {}),
    globals: decodeGlobals(inlineEvalGlobals) as Record<string, unknown>,
  };
}

let capturedValues: ValueCache | null = null;
const cache = new TransformCacheCollection();

// eslint-disable-next-line require-yield
function* collect(this: ICollectAction): SyncScenarioForAction<ICollectAction> {
  capturedValues = this.data.valueCache;
  const { loadedAndParsed } = this.entrypoint;

  return {
    ast: loadedAndParsed.ast,
    code: loadedAndParsed.code,
    map: this.services.options.inputSourceMap,
    metadata: null,
  };
}

let transformError: unknown = null;

try {
  await transform(
    {
      cache,
      options: {
        filename,
        root,
        inputSourceMap: normalizedInputSourceMap,
        pluginOptions: pluginOptionsForTransform,
      },
    },
    code,
    asyncResolveFallback,
    { collect }
  );
} catch (error) {
  transformError = error;
} finally {
  disposeEvalBroker(cache);
}

if (transformError) {
  fail(
    `[wyw-in-js] babel sync runner: transform failed for ${filename}\n${String(
      transformError
    )}`
  );
}

const serializedValues = (() => {
  if (capturedValues === null) return null;

  const values: ValueCache = capturedValues;
  const entries: Array<[string, ReturnType<typeof serializeValue>]> = [];
  values.forEach((value: unknown, key: string | number | boolean | null) => {
    entries.push([String(key), serializeValue(value)]);
  });

  return Object.fromEntries(entries);
})();

process.stdout.write(JSON.stringify({ values: serializedValues }));
