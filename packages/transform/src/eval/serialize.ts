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

const ENCODED_GLOBAL_ENVELOPE_KEY = '__wyw_eval_global';
const ENCODED_GLOBAL_SIGNATURE = 'wyw-eval-global';
const ENCODED_GLOBAL_VERSION = 1;

type EncodedFunctionPayload = {
  signature: typeof ENCODED_GLOBAL_SIGNATURE;
  version: typeof ENCODED_GLOBAL_VERSION;
  kind: 'function';
  source: string;
};

type EncodedSymbolPayload = {
  signature: typeof ENCODED_GLOBAL_SIGNATURE;
  version: typeof ENCODED_GLOBAL_VERSION;
  kind: 'symbol';
  description: string;
};

type EncodedGlobalPayload = EncodedFunctionPayload | EncodedSymbolPayload;

export type EncodedGlobal = {
  [ENCODED_GLOBAL_ENVELOPE_KEY]: EncodedGlobalPayload;
};

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

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.getPrototypeOf(value) === Object.prototype;
};

const isCallable = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === 'function';

const formatGlobalsPath = (path: Array<string | number>): string =>
  path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') {
      return `${acc}[${segment}]`;
    }

    if (/^[A-Za-z_$][\w$]*$/u.test(segment)) {
      return `${acc}.${segment}`;
    }

    return `${acc}[${JSON.stringify(segment)}]`;
  }, 'eval.globals');

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

const throwUnsupportedNonPlainObject = (
  value: object,
  path: Array<string | number>
): never => {
  throw new Error(
    `[wyw-in-js] eval.globals contains an unsupported non-plain object at ${formatGlobalsPath(
      path
    )} (${getObjectTypeName(value)}). ` +
      `Use JSON-like primitives, arrays, plain objects, functions, and symbols.`
  );
};

const restoreFunction = (source: string, path: Array<string | number>) => {
  try {
    // eslint-disable-next-line no-eval
    const restored = eval(`(${source})`) as unknown;
    if (typeof restored !== 'function') {
      throw new TypeError('decoded source is not a function');
    }

    return restored;
  } catch (error) {
    throw new Error(
      `[wyw-in-js] Failed to restore eval.globals function at ${formatGlobalsPath(
        path
      )}. ` +
        `Ensure the value is a user-defined function expression/arrow function. ` +
        `Native and bound functions are not supported. ` +
        `Original error: ${String(error)}`
    );
  }
};

const validateFunctionSource = (
  source: string,
  path: Array<string | number>
) => {
  try {
    // eslint-disable-next-line no-eval
    const restored = eval(`(${source})`) as unknown;
    if (typeof restored !== 'function') {
      throw new TypeError('decoded source is not a function');
    }
  } catch (error) {
    throw new Error(
      `[wyw-in-js] eval.globals contains an unsupported function at ${formatGlobalsPath(
        path
      )}. ` +
        `Ensure the value is a user-defined function expression/arrow function. ` +
        `Native and bound functions are not supported. ` +
        `Original error: ${String(error)}`
    );
  }
};

const serializeFunction = (
  value: (...args: unknown[]) => unknown,
  path: Array<string | number>
) => {
  const source = value.toString();

  // Validate that the source is restorable before storing it.
  validateFunctionSource(source, path);

  return source;
};

const isEncodedGlobalPayload = (
  value: unknown
): value is EncodedGlobalPayload => {
  if (!isPlainObject(value)) {
    return false;
  }

  if (
    value.signature !== ENCODED_GLOBAL_SIGNATURE ||
    value.version !== ENCODED_GLOBAL_VERSION
  ) {
    return false;
  }

  if (value.kind === 'function') {
    return typeof value.source === 'string';
  }

  if (value.kind === 'symbol') {
    return typeof value.description === 'string';
  }

  return false;
};

const isEncodedGlobal = (value: unknown): value is EncodedGlobal => {
  if (!isPlainObject(value)) {
    return false;
  }

  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== ENCODED_GLOBAL_ENVELOPE_KEY) {
    return false;
  }

  return isEncodedGlobalPayload(value[ENCODED_GLOBAL_ENVELOPE_KEY]);
};

const encodeGlobalsAtPath = (
  value: unknown,
  path: Array<string | number>
): unknown => {
  if (isCallable(value)) {
    return {
      [ENCODED_GLOBAL_ENVELOPE_KEY]: {
        signature: ENCODED_GLOBAL_SIGNATURE,
        version: ENCODED_GLOBAL_VERSION,
        kind: 'function',
        source: serializeFunction(value, path),
      },
    } satisfies EncodedGlobal;
  }

  if (typeof value === 'symbol') {
    return {
      [ENCODED_GLOBAL_ENVELOPE_KEY]: {
        signature: ENCODED_GLOBAL_SIGNATURE,
        version: ENCODED_GLOBAL_VERSION,
        kind: 'symbol',
        description: value.description ?? '',
      },
    } satisfies EncodedGlobal;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      encodeGlobalsAtPath(item, [...path, index])
    );
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        encodeGlobalsAtPath(item, [...path, key]),
      ])
    );
  }

  if (typeof value === 'object' && value !== null) {
    throwUnsupportedNonPlainObject(value, path);
  }

  return value;
};

export const encodeGlobals = (value: unknown): unknown =>
  encodeGlobalsAtPath(value, []);

const decodeGlobalsAtPath = (
  value: unknown,
  path: Array<string | number>
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      decodeGlobalsAtPath(item, [...path, index])
    );
  }

  if (isEncodedGlobal(value)) {
    const payload = value[ENCODED_GLOBAL_ENVELOPE_KEY];
    if (payload.kind === 'function') {
      return restoreFunction(payload.source, path);
    }

    return Symbol(payload.description);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        decodeGlobalsAtPath(item, [...path, key]),
      ])
    );
  }

  return value;
};

export const decodeGlobals = (value: unknown): unknown =>
  decodeGlobalsAtPath(value, []);
