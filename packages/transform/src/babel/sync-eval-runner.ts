import { readFileSync } from 'fs';

import { asyncResolveFallback } from '@wyw-in-js/shared';

import type { PluginOptions } from '../types';
import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import type { ICollectAction, SyncScenarioForAction } from '../transform/types';
import { serializeValue } from '../eval/serialize';

type SyncEvalPayload = {
  filename: string;
  root?: string;
  code: string;
  inputSourceMap?: unknown;
  pluginOptions: Partial<PluginOptions>;
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

let payload: SyncEvalPayload;
try {
  payload = JSON.parse(rawInput) as SyncEvalPayload;
} catch (error) {
  fail(
    `[wyw-in-js] babel sync runner: failed to parse input: ${String(error)}`
  );
}

const { filename, root, code, inputSourceMap, pluginOptions } = payload;

let capturedValues: Map<string, unknown> | null = null;

// eslint-disable-next-line require-yield
function* collect(
  this: ICollectAction
): SyncScenarioForAction<ICollectAction> {
  capturedValues = this.data.valueCache;
  const { loadedAndParsed } = this.entrypoint;

  return {
    ast: loadedAndParsed.ast,
    code: loadedAndParsed.code,
    map: this.services.options.inputSourceMap,
    metadata: null,
  };
}

try {
  await transform(
    {
      cache: new TransformCacheCollection(),
      options: {
        filename,
        root,
        inputSourceMap,
        pluginOptions,
      },
    },
    code,
    asyncResolveFallback,
    { collect }
  );
} catch (error) {
  fail(
    `[wyw-in-js] babel sync runner: transform failed for ${filename}\n${String(
      error
    )}`
  );
}

const serializedValues =
  capturedValues === null
    ? null
    : Object.fromEntries(
        Array.from(capturedValues.entries()).map(([key, value]) => [
          key,
          serializeValue(value),
        ])
      );

process.stdout.write(JSON.stringify({ values: serializedValues }));
