export type SerializedError = {
  message: string;
  name?: string;
  stack?: string;
};

export type SerializedValue =
  | { kind: 'value'; value: unknown }
  | { kind: 'function' }
  | { kind: 'error'; error: SerializedError }
  | { kind: 'undefined' }
  | { kind: 'bigint'; value: string }
  | { kind: 'nan' }
  | { kind: 'infinity' }
  | { kind: '-infinity' };

export type EncodedGlobal =
  | { __wyw_function: string }
  | { __wyw_symbol: string };

const isLikeError = (value: unknown): value is Error =>
  typeof value === 'object' &&
  value !== null &&
  'message' in value &&
  'stack' in value;

const isJsonSafe = (value: unknown): boolean => {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
};

export const serializeValue = (value: unknown): SerializedValue => {
  if (value === undefined) {
    return { kind: 'undefined' };
  }

  if (typeof value === 'bigint') {
    return { kind: 'bigint', value: value.toString() };
  }

  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return { kind: 'nan' };
    }
    if (value === Infinity) {
      return { kind: 'infinity' };
    }
    if (value === -Infinity) {
      return { kind: '-infinity' };
    }
  }

  if (typeof value === 'function') {
    return { kind: 'function' };
  }

  if (isLikeError(value)) {
    return {
      kind: 'error',
      error: {
        message: value.message,
        name: value.name,
        stack: value.stack,
      },
    };
  }

  if (!isJsonSafe(value)) {
    throw new Error(
      `[wyw-in-js] __wywPreval produced a non-serializable value during eval. ` +
        `Use importOverrides to mock the import or return a JSON-safe value.`
    );
  }

  return { kind: 'value', value };
};

export const deserializeValue = (value: SerializedValue): unknown => {
  switch (value.kind) {
    case 'undefined':
      return undefined;
    case 'bigint':
      return BigInt(value.value);
    case 'nan':
      return Number.NaN;
    case 'infinity':
      return Infinity;
    case '-infinity':
      return -Infinity;
    case 'function':
      return () => {};
    case 'error': {
      const error = new Error(value.error.message);
      if (value.error.name) {
        error.name = value.error.name;
      }

      if (value.error.stack) {
        error.stack = value.error.stack;
      }

      return error;
    }
    case 'value':
    default:
      return value.value;
  }
};

export const serializePreval = (
  values: Record<string, unknown>
): Record<string, SerializedValue> =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, serializeValue(value)])
  );

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const encodeGlobals = (value: unknown): unknown => {
  if (typeof value === 'function') {
    return { __wyw_function: value.toString() } satisfies EncodedGlobal;
  }

  if (typeof value === 'symbol') {
    return {
      __wyw_symbol: value.description ?? '',
    } satisfies EncodedGlobal;
  }

  if (Array.isArray(value)) {
    return value.map((item) => encodeGlobals(item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeGlobals(item)])
    );
  }

  return value;
};

export const decodeGlobals = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => decodeGlobals(item));
  }

  if (isPlainObject(value)) {
    if ('__wyw_function' in value) {
      const source = value.__wyw_function;
      try {
        // eslint-disable-next-line no-eval
        return eval(`(${source})`);
      } catch (error) {
        throw new Error(
          `[wyw-in-js] Failed to restore eval.globals function: ${String(
            error
          )}`
        );
      }
    }

    if ('__wyw_symbol' in value) {
      const description = value.__wyw_symbol;
      return Symbol(
        typeof description === 'string' ? description : String(description)
      );
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decodeGlobals(item)])
    );
  }

  return value;
};
