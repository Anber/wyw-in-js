/* eslint-disable no-underscore-dangle */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import NativeModule, { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Minimatch } from 'minimatch';

class LruCache {
  constructor(maxSize) {
    this.maxSize = Math.max(1, maxSize);
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
  }

  clear() {
    this.map.clear();
  }
}

const NOOP = () => {};

const VITE_VIRTUAL_PREFIX = '/@';
const REACT_REFRESH_VIRTUAL_ID = '/@react-refresh';
const reactRefreshRuntime = {
  createSignatureFunctionForTransform: () => () => {},
};

const builtins = {
  assert: true,
  buffer: true,
  child_process: false,
  cluster: false,
  console: true,
  constants: true,
  crypto: true,
  dgram: false,
  dns: false,
  domain: true,
  events: true,
  fs: false,
  http: true,
  https: true,
  module: false,
  net: false,
  os: true,
  path: true,
  punycode: true,
  process: true,
  querystring: true,
  readline: false,
  repl: false,
  stream: true,
  string_decoder: true,
  sys: true,
  timers: true,
  tls: false,
  tty: true,
  url: true,
  util: true,
  vm: true,
  zlib: true,
};

const RESOLVE_CACHE_SIZE = 5000;
const LOAD_CACHE_SIZE = 1000;

const isBuiltinSpecifier = (specifier) => {
  const normalized = specifier.startsWith('node:')
    ? specifier.slice(5)
    : specifier;
  return (
    NativeModule.builtinModules?.includes(normalized) ||
    NativeModule.builtinModules?.includes(`node:${normalized}`)
  );
};

const packageTypeCache = new Map();

const getPackageType = (filename) => {
  let dir = path.dirname(filename);
  while (dir && dir !== path.dirname(dir)) {
    const cached = packageTypeCache.get(dir);
    if (cached !== undefined) return cached;
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const type = pkg?.type === 'module' ? 'module' : 'commonjs';
        packageTypeCache.set(dir, type);
        return type;
      } catch {
        packageTypeCache.set(dir, null);
        return null;
      }
    }
    packageTypeCache.set(dir, null);
    dir = path.dirname(dir);
  }
  return null;
};

const shouldPreferImport = (resolvedFile) => {
  if (!resolvedFile) return false;
  if (!path.isAbsolute(resolvedFile)) return false;
  if (resolvedFile.endsWith('.mjs')) return true;
  if (resolvedFile.endsWith('.cjs')) return false;
  if (!resolvedFile.endsWith('.js')) return false;
  return getPackageType(resolvedFile) === 'module';
};

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const decodeGlobals = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => decodeGlobals(item));
  }

  if (isPlainObject(value)) {
    if ('__wyw_function' in value) {
      const source = value.__wyw_function;
      // eslint-disable-next-line no-eval
      return eval(`(${source})`);
    }
    if ('__wyw_symbol' in value) {
      return Symbol(value.__wyw_symbol);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decodeGlobals(item)])
    );
  }

  return value;
};

const isJsonSafe = (value) => {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
};

const isErrRequireEsm = (error) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'ERR_REQUIRE_ESM';

const serializeValue = (value) => {
  if (value === undefined) return { kind: 'undefined' };
  if (typeof value === 'bigint') {
    return { kind: 'bigint', value: value.toString() };
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { kind: 'nan' };
    if (value === Infinity) return { kind: 'infinity' };
    if (value === -Infinity) return { kind: '-infinity' };
  }
  if (typeof value === 'function') return { kind: 'function' };
  if (
    value &&
    typeof value === 'object' &&
    'message' in value &&
    'stack' in value
  ) {
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
      `[wyw-in-js] __wywPreval produced a non-serializable value during eval.`
    );
  }
  return { kind: 'value', value };
};

const deserializeValue = (value) => {
  switch (value?.kind) {
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
      const error = new Error(value.error?.message ?? '');
      if (value.error?.name) {
        error.name = value.error.name;
      }
      if (value.error?.stack) {
        error.stack = value.error.stack;
      }
      return error;
    }
    case 'value':
    default:
      return value?.value;
  }
};

const IMPORT_META_ENV = '__wyw_import_meta_env';

let importMetaEnvWarned = false;
let happyDomLoadWarned = false;
let happyDomUnavailable = false;
let happyDomImportPromise = null;
const debugEnabled = Boolean(process.env.WYW_EVAL_RUNNER_DEBUG);
const debug = (...args) => {
  if (!debugEnabled) return;
  // eslint-disable-next-line no-console
  console.warn('[wyw-eval-runner:debug]', ...args);
};

const processShim = {
  nextTick: (fn) => setTimeout(fn, 0),
  platform: 'browser',
  arch: 'browser',
  execPath: 'browser',
  title: 'browser',
  pid: 1,
  browser: true,
  argv: [],
  binding() {
    throw new Error('No such module. (Possibly not yet loaded)');
  },
  cwd: () => '/',
  exit: NOOP,
  kill: NOOP,
  chdir: NOOP,
  umask: NOOP,
  dlopen: NOOP,
  uptime: NOOP,
  memoryUsage: NOOP,
  uvCounters: NOOP,
  features: {},
  env: process.env,
};

const createImportMetaEnvProxy = () => {
  const target = Object.create(null);
  const warnOnce = () => {
    if (importMetaEnvWarned) return;
    importMetaEnvWarned = true;
    // eslint-disable-next-line no-console
    console.warn(
      [
        `[wyw-in-js] import.meta.env was accessed during build-time evaluation, but no env values were provided.`,
        ``,
        `If you're using Vite, make sure @wyw-in-js/vite plugin is enabled (it injects Vite env for evaluation).`,
        `Otherwise provide "__wyw_import_meta_env" via pluginOptions.overrideContext.`,
      ].join('\n')
    );
  };

  return new Proxy(target, {
    get(obj, key) {
      if (typeof key === 'symbol') return Reflect.get(obj, key);
      warnOnce();
      return obj[key];
    },
    has(obj, key) {
      if (typeof key === 'symbol') return Reflect.has(obj, key);
      warnOnce();
      return Reflect.has(obj, key);
    },
    getOwnPropertyDescriptor(obj, key) {
      return Reflect.getOwnPropertyDescriptor(obj, key);
    },
    ownKeys(obj) {
      return Reflect.ownKeys(obj);
    },
    set(obj, key, value) {
      if (typeof key === 'symbol') return Reflect.set(obj, key, value);
      warnOnce();
      return Reflect.set(obj, key, value);
    },
  });
};

const HAPPY_DOM_TIMEOUT_MS = Number(
  process.env.WYW_HAPPYDOM_TIMEOUT_MS || 5000
);

const withTimeout = (promise, timeoutMs, label) => {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(
        `[wyw-in-js] Timed out while waiting for ${label}.`
      );
      error.code = 'WYW_HAPPYDOM_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
};

const loadHappyDom = async () => {
  if (!happyDomImportPromise) {
    happyDomImportPromise = import('happy-dom');
  }
  return happyDomImportPromise;
};

const createWindow = async () => {
  if (happyDomUnavailable) return undefined;
  try {
    debug('happyDom:import:start');
    const importStart = Date.now();
    const { Window, GlobalWindow } = await withTimeout(
      loadHappyDom(),
      HAPPY_DOM_TIMEOUT_MS,
      'happy-dom import'
    );
    debug('happyDom:import:done', Date.now() - importStart);
    const HappyWindow = GlobalWindow || Window;
    const windowStart = Date.now();
    const win = new HappyWindow();
    debug('happyDom:window:done', Date.now() - windowStart);
    win.Buffer = Buffer;
    win.Uint8Array = Uint8Array;
    return win;
  } catch (error) {
    happyDomUnavailable = true;
    happyDomImportPromise = null;
    if (!happyDomLoadWarned) {
      happyDomLoadWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        [
          `[wyw-in-js] DOM emulation is enabled (features.happyDOM), but "happy-dom" could not be loaded in this build-time runtime.`,
          `WyW will continue without DOM emulation (as if features.happyDOM:false).`,
          ``,
          `To silence this warning: set features: { happyDOM: false }.`,
          `To restore DOM emulation, ensure "happy-dom" can be imported in the build-time runtime.`,
        ].join('\n')
      );
    }
    return undefined;
  }
};

const setReferencePropertyIfNotPresent = (context, key) => {
  if (context[key] === context) return;
  context[key] = context;
};

const createBaseContext = (win, additionalContext) => {
  const baseContext = win ?? {};
  setReferencePropertyIfNotPresent(baseContext, 'window');
  setReferencePropertyIfNotPresent(baseContext, 'self');
  setReferencePropertyIfNotPresent(baseContext, 'top');
  setReferencePropertyIfNotPresent(baseContext, 'parent');
  setReferencePropertyIfNotPresent(baseContext, 'global');
  setReferencePropertyIfNotPresent(baseContext, 'process');

  baseContext.document = win?.document;
  baseContext.process = processShim;

  baseContext.clearImmediate = NOOP;
  baseContext.clearInterval = NOOP;
  baseContext.clearTimeout = NOOP;
  baseContext.setImmediate = NOOP;
  baseContext.requestAnimationFrame = NOOP;
  baseContext.setInterval = NOOP;
  baseContext.setTimeout = NOOP;

  Object.assign(baseContext, additionalContext);
  return baseContext;
};

const featureMatchers = new Map();

const isFeatureEnabled = (features, featureName, filename) => {
  const value = features?.[featureName] ?? false;
  if (typeof value === 'boolean') return value;
  if (value === '*' || value === '**/*') return true;

  const array = Array.isArray(value) ? value : [value];
  return array
    .map((pattern) => {
      let matcher = featureMatchers.get(pattern);
      if (!matcher) {
        matcher = [pattern.startsWith('!'), new Minimatch(pattern)];
        featureMatchers.set(pattern, matcher);
      }
      return [matcher[0], matcher[1].match(filename)];
    })
    .reduce(
      (acc, [negated, match]) => (negated ? acc && match : acc || match),
      false
    );
};

const createVmContext = async (filename, features, globals) => {
  const isHappyDomEnabled = isFeatureEnabled(features, 'happyDOM', filename);
  const win = isHappyDomEnabled ? await createWindow() : undefined;
  const envContext = {
    [IMPORT_META_ENV]: createImportMetaEnvProxy(),
  };
  const baseContext = createBaseContext(win, {
    __filename: filename,
    ...envContext,
    ...globals,
  });
  const context = vm.createContext(baseContext);
  return {
    context,
    teardown: () => {
      if (win?.happyDOM) {
        win.happyDOM.abort();
      }
    },
  };
};

const stripQueryAndHash = (value) =>
  value.split('?')[0]?.split('#')[0] ?? value;

const normalizeResolvedId = (resolvedId, specifier, importer) => {
  const stripped = stripQueryAndHash(resolvedId);
  if (!stripped) return resolvedId;
  if (path.extname(stripped)) return resolvedId;

  const isFileSpecifier =
    specifier.startsWith('.') || path.isAbsolute(specifier);
  if (!isFileSpecifier && !path.isAbsolute(stripped)) {
    return resolvedId;
  }

  let candidate = stripped;
  if (!path.isAbsolute(candidate)) {
    if (!importer) {
      return resolvedId;
    }
    const importerFile = stripQueryAndHash(importer);
    candidate = path.resolve(path.dirname(importerFile), candidate);
  }

  const suffix = resolvedId.slice(stripped.length);
  const extensions = state.evalOptions.extensions ?? [];
  for (const ext of extensions) {
    const fileCandidate = `${candidate}${ext}`;
    if (fs.existsSync(fileCandidate)) {
      return `${fileCandidate}${suffix}`;
    }

    const indexCandidate = path.join(candidate, `index${ext}`);
    if (fs.existsSync(indexCandidate)) {
      return `${indexCandidate}${suffix}`;
    }
  }

  if (importer) {
    try {
      const importerFile = stripQueryAndHash(importer);
      const nodeRequire = createRequire(pathToFileURL(importerFile).href);
      const resolved = nodeRequire.resolve(stripQueryAndHash(specifier));
      if (resolved && resolved !== stripped) {
        return `${resolved}${suffix}`;
      }
    } catch {
      // ignore fallback failures
    }
  }

  return resolvedId;
};

const isNodeModulesId = (id) => {
  if (!id) return false;
  const normalized = stripQueryAndHash(id).replace(/\\/g, '/');
  return normalized.includes('/node_modules/');
};

const mergeOnly = (current, next) => {
  if (!current || current.length === 0) return next ?? [];
  if (!next || next.length === 0) return current;
  if (current.includes('*') || next.includes('*')) {
    return ['*'];
  }
  return Array.from(new Set([...current, ...next]));
};

const toCanonicalFileKey = (resolved, root) => {
  const rootDir = root ? path.resolve(root) : process.cwd();
  const normalizedResolved = path.resolve(resolved);
  let relative = path.relative(rootDir, normalizedResolved);

  if (path.sep !== path.posix.sep) {
    relative = relative.split(path.sep).join(path.posix.sep);
  }

  if (!relative.startsWith('.')) {
    relative = `./${relative}`;
  }

  return relative;
};

const toImportKey = ({ source, resolved, root }) => {
  const isFileImport = source.startsWith('.') || path.isAbsolute(source);
  if (isFileImport && resolved) {
    return { key: toCanonicalFileKey(resolved, root), kind: 'file' };
  }
  return { key: source, kind: 'package' };
};

const minimatchOptions = {
  dot: true,
  nocomment: true,
  nonegate: true,
};

const compileImportOverrides = (importOverrides) => {
  const matchers = Object.entries(importOverrides)
    .map(([pattern, override]) => ({
      matcher: new Minimatch(pattern, minimatchOptions),
      override,
      pattern,
    }))
    .sort((a, b) => b.pattern.length - a.pattern.length);

  return { matchers };
};

const compiledOverridesCache = new WeakMap();

const getImportOverride = (importOverrides, key) => {
  if (!importOverrides) return undefined;
  const direct = importOverrides[key];
  if (direct) return direct;

  let compiled = compiledOverridesCache.get(importOverrides);
  if (!compiled) {
    compiled = compileImportOverrides(importOverrides);
    compiledOverridesCache.set(importOverrides, compiled);
  }

  return compiled.matchers.find(({ matcher }) => matcher.match(key))?.override;
};

const resolveMockSpecifier = ({ mock, importer, root }) => {
  const specifier =
    mock.startsWith('.') && root ? path.resolve(root, mock) : mock;
  const nodeRequire = createRequire(pathToFileURL(importer).href);
  return nodeRequire.resolve(specifier);
};

const state = {
  context: null,
  teardown: null,
  happyDomEnabled: null,
  evalOptions: {
    mode: 'strict',
    require: 'warn-and-run',
    globals: {},
    importOverrides: undefined,
    root: undefined,
    extensions: [],
  },
  features: {},
  entrypoint: 'eval-runner',
};

const moduleCache = new LruCache(LOAD_CACHE_SIZE);
const moduleHashes = new Map();
const moduleData = new Map();
const moduleOnly = new Map();
const linkPromises = new Map();
const loadInFlight = new Map();
const externalInFlight = new Map();
const resolveCache = new LruCache(RESOLVE_CACHE_SIZE);
const resolveInFlight = new Map();

const pending = new Map();
let nextId = 0;

const resetModuleState = () => {
  moduleCache.clear();
  moduleHashes.clear();
  moduleData.clear();
  moduleOnly.clear();
  linkPromises.clear();
  loadInFlight.clear();
  externalInFlight.clear();
  resolveInFlight.clear();
  resolveCache.clear();
};

const resetEvaluationState = () => {
  if (state.teardown) {
    state.teardown();
  }
  state.context = null;
  state.teardown = null;
  state.happyDomEnabled = null;
  resetModuleState();
};

const sendMessage = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const sendWarn = (warning) => {
  sendMessage({ type: 'WARN', payload: warning });
};

const request = (type, payload) => {
  nextId += 1;
  const id = `${nextId}`;
  sendMessage({ type, id, payload });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
};

const resolvePending = (id, payload) => {
  const pendingItem = pending.get(id);
  if (!pendingItem) return;
  pending.delete(id);
  pendingItem.resolve(payload);
};

const buildPreamble = (id) =>
  [
    `const __wyw_module = __wyw_getModule(${JSON.stringify(id)});`,
    `let exports = __wyw_module.exports;`,
    `const module = __wyw_module.module;`,
    `const require = __wyw_module.require;`,
    `const __filename = __wyw_module.filename;`,
    `const __dirname = __wyw_module.dirname;`,
    `const __wyw_dynamic_import = __wyw_module.dynamicImport;`,
    ``,
  ].join('\n');

const getImporterPackage = (importer) => {
  const normalized = importer.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return path.basename(importer);
  const rest = normalized.slice(idx + marker.length);
  if (rest.startsWith('@')) {
    const [scope, name] = rest.split('/').slice(0, 2);
    return `${scope}/${name}`;
  }
  return rest.split('/')[0];
};

const warnedRequires = new Set();

const createRequireFn = (importer) => {
  const importerFile = stripQueryAndHash(importer);
  const nodeRequire = createRequire(pathToFileURL(importerFile).href);

  return (specifier, resolvedOverride) => {
    if (state.evalOptions.require === 'off') {
      throw new Error(
        `[wyw-in-js] require() fallback is disabled by eval.require: 'off'.`
      );
    }

    if (typeof specifier !== 'string') {
      if (state.evalOptions.mode === 'strict') {
        throw new Error(
          `[wyw-in-js] Non-literal require() is not supported during eval.\n` +
            `importer: ${importerFile}\n` +
            `hint: make it a string literal or mock the import via importOverrides.`
        );
      }

      sendWarn({
        code: 'require-error',
        message:
          '[wyw-in-js] Non-literal require() reached during eval (loose mode).',
        importer: importerFile,
      });
      return {};
    }

    if (specifier === REACT_REFRESH_VIRTUAL_ID) {
      return reactRefreshRuntime;
    }

    if (
      specifier.startsWith(VITE_VIRTUAL_PREFIX) ||
      specifier.startsWith('virtual:')
    ) {
      return {};
    }

    const normalized = specifier.startsWith('node:')
      ? specifier.slice(5)
      : specifier;
    if (
      NativeModule.builtinModules?.includes(normalized) ||
      NativeModule.builtinModules?.includes(`node:${normalized}`)
    ) {
      if (normalized in builtins) {
        if (builtins[normalized]) {
          return nodeRequire(normalized);
        }
        return null;
      }
    }

    const extensions = NativeModule._extensions;
    const added = [];

    try {
      state.evalOptions.extensions?.forEach((ext) => {
        if (ext in extensions) return;
        extensions[ext] = NOOP;
        added.push(ext);
      });

      let resolved = resolvedOverride
        ? stripQueryAndHash(resolvedOverride)
        : nodeRequire.resolve(stripQueryAndHash(specifier));

      const isFileSpecifier =
        specifier.startsWith('.') || path.isAbsolute(specifier);
      if (
        isFileSpecifier &&
        path.extname(specifier) === '' &&
        resolved.endsWith('.cjs')
      ) {
        const candidate = `${resolved.slice(0, -4)}.js`;
        if (fs.existsSync(candidate)) {
          resolved = candidate;
        }
      }

      const keyInfo = toImportKey({
        source: specifier,
        resolved,
        root: state.evalOptions.root,
      });
      const override = getImportOverride(
        state.evalOptions.importOverrides,
        keyInfo.key
      );

      let finalResolved = resolved;
      if (override?.mock) {
        finalResolved = resolveMockSpecifier({
          mock: override.mock,
          importer: importerFile,
          root: state.evalOptions.root,
          stack: [importerFile],
        });
      }

      const basePolicy =
        state.evalOptions.require === 'warn-and-run' ? 'warn' : 'error';
      let policy = override?.unknown ?? (override ? 'allow' : basePolicy);
      if (state.evalOptions.require === 'off' && policy !== 'error') {
        policy = 'error';
      }

      if (policy === 'error') {
        throw new Error(
          [
            `[wyw-in-js] require() fallback reached during eval but eval.require='error'.`,
            ``,
            `importer: ${importerFile}`,
            `source:   ${specifier}`,
            `hint: add importOverrides or set eval.require to "warn-and-run".`,
          ].join('\n')
        );
      }

      if (policy === 'warn') {
        const key = `${specifier}::${getImporterPackage(importerFile)}`;
        if (!warnedRequires.has(key)) {
          warnedRequires.add(key);
          sendWarn({
            code: 'require-fallback',
            message: [
              `[wyw-in-js] Runtime require() fallback during eval`,
              ``,
              `importer: ${importerFile}`,
              `source:   ${specifier}`,
              `resolved: ${resolved}`,
              override?.mock
                ? `mock:     ${override.mock} -> ${finalResolved}`
                : ``,
              ``,
              `hint: use importOverrides to mock runtime-only deps and avoid eval-time requires.`,
            ]
              .filter(Boolean)
              .join('\n'),
            importer: importerFile,
            specifier,
            resolved,
          });
        }
      }

      return nodeRequire(finalResolved);
    } finally {
      added.forEach((ext) => delete extensions[ext]);
    }
  };
};

function createSyntheticModule(id, exportsValue) {
  const exportNames = new Set(Object.keys(exportsValue));
  if (!exportNames.has('default')) {
    exportNames.add('default');
  }

  const module = new vm.SyntheticModule(
    [...exportNames],
    function init() {
      exportNames.forEach((key) => {
        const value =
          key === 'default' ? exportsValue.default : exportsValue[key];
        this.setExport(key, value);
      });
    },
    { context: state.context, identifier: id }
  );

  moduleCache.set(id, module);
  return module;
}

const toSyntheticExports = (value) => {
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    const exportsValue = {};
    Object.keys(value).forEach((key) => {
      exportsValue[key] = value[key];
    });
    exportsValue.default =
      Object.prototype.hasOwnProperty.call(value, 'default') ||
      Object.prototype.hasOwnProperty.call(exportsValue, 'default')
        ? value.default
        : value;
    return exportsValue;
  }
  return { default: value };
};

const loadExternalModule = async (resolvedId, importer, specifier) => {
  const cacheId = resolvedId ?? specifier;
  const cached = moduleCache.get(cacheId);
  if (cached) return cached;

  const inFlight = externalInFlight.get(cacheId);
  if (inFlight) return inFlight;

  const task = (async () => {
    const start = Date.now();
    debug('external:start', { specifier, resolvedId, importer });
    const requireFn = createRequireFn(importer);
    let value;
    let hasValue = false;
    const resolvedFile = resolvedId ? stripQueryAndHash(resolvedId) : null;
    const importTarget =
      resolvedFile && path.isAbsolute(resolvedFile)
        ? pathToFileURL(resolvedFile).href
        : specifier;

    if (shouldPreferImport(resolvedFile)) {
      value = await import(importTarget);
      hasValue = true;
    }
    if (!hasValue) {
      try {
        value = requireFn(specifier, resolvedId ?? null);
        hasValue = true;
      } catch (error) {
        if (!isErrRequireEsm(error)) {
          throw error;
        }

        const isFileSpecifier =
          specifier.startsWith('.') || path.isAbsolute(specifier);
        const isPackageSpecifier =
          !isFileSpecifier && !isBuiltinSpecifier(specifier);
        if (resolvedId && isPackageSpecifier) {
          try {
            value = requireFn(specifier, null);
            hasValue = true;
          } catch (retryError) {
            if (!isErrRequireEsm(retryError)) {
              throw retryError;
            }
          }
        }

        if (!hasValue) {
          value = await import(importTarget);
          hasValue = true;
        }
      }
    }

    const module = createSyntheticModule(cacheId, toSyntheticExports(value));
    debug('external:done', {
      specifier,
      resolvedId,
      durationMs: Date.now() - start,
    });
    return module;
  })();

  externalInFlight.set(cacheId, task);
  try {
    return await task;
  } finally {
    externalInFlight.delete(cacheId);
  }
};

let resolveModule;
let loadModule;

const linkModule = async (module) => {
  const cached = linkPromises.get(module);
  if (cached) return cached;
  if (module.status !== 'unlinked') return module;
  const linking = module.link((specifier, referencingModule) =>
    resolveModule(specifier, referencingModule.identifier, 'import')
  );
  linkPromises.set(module, linking);
  await linking;
  return module;
};

resolveModule = async (specifier, importer, kind) => {
  if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
    process.stderr.write(
      `[wyw-eval-runner:resolve] ${JSON.stringify({
        specifier,
        importer,
        kind,
      })}\n`
    );
  }
  if (specifier === REACT_REFRESH_VIRTUAL_ID) {
    return createSyntheticModule(specifier, reactRefreshRuntime);
  }

  if (
    specifier.startsWith(VITE_VIRTUAL_PREFIX) ||
    specifier.startsWith('virtual:')
  ) {
    return createSyntheticModule(specifier, { default: {} });
  }

  const key = `${kind}:${importer}:${specifier}`;
  const cached = resolveCache.get(key);
  if (cached) {
    if (!cached.resolvedId) {
      if (state.evalOptions.mode === 'loose') {
        return createSyntheticModule(specifier, { default: undefined });
      }
      throw new Error(
        [
          `[wyw-in-js] Unable to resolve "${specifier}" during evaluation.`,
          ``,
          `importer: ${importer}`,
          `hint: check eval.resolver/customResolver or add importOverrides for this specifier.`,
        ].join('\n')
      );
    }

    const treatExternal =
      cached.external ||
      isBuiltinSpecifier(specifier) ||
      isNodeModulesId(cached.resolvedId);

    if (treatExternal) {
      const normalized = normalizeResolvedId(
        cached.resolvedId,
        specifier,
        importer
      );
      return loadExternalModule(normalized, importer, specifier);
    }

    const normalized = normalizeResolvedId(
      cached.resolvedId,
      specifier,
      importer
    );
    return loadModule(normalized, importer, specifier);
  }

  const inFlight = resolveInFlight.get(key);
  if (inFlight) return inFlight;

  const task = (async () => {
    const resolved = await request('RESOLVE', {
      specifier,
      importerId: importer,
      kind,
    });

    if (resolved.error) {
      throw new Error(resolved.error.message);
    }

    const normalized = resolved.resolvedId
      ? normalizeResolvedId(resolved.resolvedId, specifier, importer)
      : resolved.resolvedId;
    if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
      process.stderr.write(
        `[wyw-eval-runner:resolved] ${JSON.stringify({
          specifier,
          importer,
          resolved: resolved.resolvedId ?? null,
          normalized: normalized ?? null,
          external: Boolean(resolved.external),
        })}\n`
      );
    }

    resolveCache.set(key, {
      resolvedId: normalized,
      external: Boolean(resolved.external),
    });

    if (!normalized) {
      if (state.evalOptions.mode === 'loose') {
        return createSyntheticModule(specifier, { default: undefined });
      }
      throw new Error(
        [
          `[wyw-in-js] Unable to resolve "${specifier}" during evaluation.`,
          ``,
          `importer: ${importer}`,
          `hint: check eval.resolver/customResolver or add importOverrides for this specifier.`,
        ].join('\n')
      );
    }

    const treatExternal =
      resolved.external ||
      isBuiltinSpecifier(specifier) ||
      isNodeModulesId(normalized);

    if (treatExternal) {
      return loadExternalModule(normalized, importer, specifier);
    }

    return loadModule(normalized, importer, specifier);
  })();

  resolveInFlight.set(key, task);
  try {
    return await task;
  } finally {
    resolveInFlight.delete(key);
  }
};

loadModule = async (id, importer, requestSpec) => {
  const cached = moduleCache.get(id);
  const inFlight = loadInFlight.get(id);
  if (inFlight) return inFlight;

  const task = (async () => {
    const loadStart = Date.now();
    const loaded = await request('LOAD', {
      id,
      importerId: importer,
      request: requestSpec ?? null,
    });
    debug('load:done', {
      id,
      importer,
      durationMs: Date.now() - loadStart,
    });

    if (loaded.error) {
      throw new Error(loaded.error.message);
    }

    if (loaded.only) {
      const current = moduleOnly.get(id) ?? [];
      moduleOnly.set(id, mergeOnly(current, loaded.only));
    }

    if (loaded.exports) {
      if (cached && loaded.hash && moduleHashes.get(id) === loaded.hash) {
        return cached;
      }
      const exportsValue = {};
      Object.entries(loaded.exports).forEach(([key, serialized]) => {
        exportsValue[key] = deserializeValue(serialized);
      });
      const module = createSyntheticModule(id, exportsValue);
      if (loaded.hash) {
        moduleHashes.set(id, loaded.hash);
      }
      return module;
    }

    if (cached && loaded.hash && moduleHashes.get(id) === loaded.hash) {
      return cached;
    }

    const module = new vm.SourceTextModule(
      `${buildPreamble(id)}${loaded.code ?? ''}`,
      {
        context: state.context,
        identifier: id,
        initializeImportMeta(meta, targetModule) {
          const identifier =
            typeof targetModule.identifier === 'string'
              ? targetModule.identifier
              : id;
          const fileId = stripQueryAndHash(identifier);
          // eslint-disable-next-line no-param-reassign
          meta.url = path.isAbsolute(fileId)
            ? pathToFileURL(fileId).href
            : fileId;
        },
        importModuleDynamically(specifier, referencingModule) {
          return resolveModule(
            specifier,
            referencingModule.identifier,
            'dynamic-import'
          );
        },
      }
    );

    moduleCache.set(id, module);
    if (loaded.hash) {
      moduleHashes.set(id, loaded.hash);
    }
    return module;
  })();

  loadInFlight.set(id, task);
  try {
    return await task;
  } finally {
    loadInFlight.delete(id);
  }
};

const createDynamicImportFn = (importer) => {
  return async (specifier) => {
    if (typeof specifier !== 'string') {
      sendWarn({
        code: 'eval-error',
        message:
          '[wyw-in-js] Dynamic import with non-string specifier during eval.',
        importer,
      });
      if (state.evalOptions.mode === 'strict') {
        throw new Error(
          `[wyw-in-js] Dynamic import with non-string specifier is not supported during eval.\n` +
            `importer: ${importer}\n` +
            `hint: make it a string literal or mock the import via importOverrides.`
        );
      }
      return createSyntheticModule(`dynamic:${String(specifier)}`, {
        default: undefined,
      });
    }

    sendWarn({
      code: 'dynamic-import',
      message: `[wyw-in-js] Dynamic import executed during eval: ${specifier}`,
      importer,
      specifier,
    });

    const resolved = await resolveModule(specifier, importer, 'dynamic-import');
    await linkModule(resolved);
    await resolved.evaluate();
    return resolved;
  };
};

const getModuleData = (id) => {
  const cached = moduleData.get(id);
  if (cached) return cached;

  const filename = stripQueryAndHash(id);
  const exportsValue = {};
  const moduleObj = { exports: exportsValue };
  const data = {
    exports: exportsValue,
    module: moduleObj,
    require: createRequireFn(id),
    filename,
    dirname: path.dirname(filename),
    dynamicImport: createDynamicImportFn(id),
  };

  moduleData.set(id, data);
  return data;
};

const resolveExportValue = (source, key) => {
  if (key === 'default') {
    if (source && typeof source === 'object' && 'default' in source) {
      return source.default;
    }
    return source;
  }

  if (source && (typeof source === 'object' || typeof source === 'function')) {
    if (key in source) {
      return source[key];
    }
    if (
      source.default &&
      typeof source.default === 'object' &&
      key in source.default
    ) {
      return source.default[key];
    }
  }

  return undefined;
};

const collectModuleExports = () => {
  const exportsByModule = {};

  moduleOnly.forEach((only, id) => {
    if (!only || only.length === 0) return;

    const module = moduleCache.get(id);
    const data = moduleData.get(id);
    if (!module || !data) return;

    const namespace = module.namespace;
    const hasNamespace =
      namespace && typeof namespace === 'object' && Object.keys(namespace).length;
    const source = hasNamespace ? namespace : data.module.exports;

    const keys = only.includes('*')
      ? Object.keys(source ?? {}).filter(
          (key) => key !== '__wywPreval' && key !== 'side-effect'
        )
      : only.filter((key) => key !== '__wywPreval' && key !== 'side-effect');

    if (keys.length === 0) return;

    const serialized = {};
    keys.forEach((key) => {
      const value = resolveExportValue(source, key);
      try {
        serialized[key] = serializeValue(value);
      } catch {
        // Skip non-serializable exports when caching eval values.
      }
    });

    if (Object.keys(serialized).length) {
      exportsByModule[id] = serialized;
    }
  });

  return exportsByModule;
};

async function evaluateEntrypoint(id) {
  const evalStart = Date.now();
  debug('eval:start', id);
  const module = await loadModule(id, id, id);
  debug('eval:loaded', { id, durationMs: Date.now() - evalStart });
  await linkModule(module);
  debug('eval:linked', { id, durationMs: Date.now() - evalStart });
  await module.evaluate();
  debug('eval:evaluated', { id, durationMs: Date.now() - evalStart });

  const data = getModuleData(id);
  const exportsValue = data.module.exports;
  const hasPrevalExport =
    exportsValue &&
    typeof exportsValue === 'object' &&
    '__wywPreval' in exportsValue;
  const { namespace } = module;
  const hasPrevalNamespace =
    namespace && typeof namespace === 'object' && '__wywPreval' in namespace;

  const modules = collectModuleExports();

  if (!hasPrevalExport && !hasPrevalNamespace) {
    return { values: null, modules };
  }

  const preval = hasPrevalExport
    ? exportsValue.__wywPreval
    : namespace.__wywPreval;
  if (!preval || typeof preval !== 'object') {
    return { values: null, modules };
  }

  const values = {};
  Object.entries(preval).forEach(([key, lazy]) => {
    let value;
    try {
      value = typeof lazy === 'function' ? lazy() : lazy;
    } catch (error) {
      value = error;
    }
    values[key] = serializeValue(value);
  });

  return { values, modules };
}

const handleMessage = async (message) => {
  switch (message.type) {
    case 'INIT': {
      try {
        const initStart = Date.now();
        debug('init:start', message.payload.entrypoint ?? 'eval-runner');
        const nextEvalOptions = {
          ...state.evalOptions,
          ...message.payload.evalOptions,
          globals: decodeGlobals(message.payload.evalOptions.globals ?? {}),
        };
        const nextFeatures = message.payload.features ?? {};
        const nextEntrypoint = message.payload.entrypoint ?? 'eval-runner';
        const nextHappyDomEnabled = isFeatureEnabled(
          nextFeatures,
          'happyDOM',
          nextEntrypoint
        );

        const canReuseContext =
          state.context && state.happyDomEnabled === nextHappyDomEnabled;

        if (canReuseContext) {
          resetModuleState();
          state.evalOptions = nextEvalOptions;
          state.features = nextFeatures;
          state.entrypoint = nextEntrypoint;
          Object.assign(state.context, {
            ...nextEvalOptions.globals,
            __wyw_getModule: (moduleId) => getModuleData(moduleId),
          });
          debug('init:reuse', Date.now() - initStart);
          sendMessage({ type: 'INIT_ACK', id: message.id });
          break;
        }

        resetEvaluationState();
        state.evalOptions = nextEvalOptions;
        state.features = nextFeatures;
        state.entrypoint = nextEntrypoint;
        debug('init:globals', Date.now() - initStart);

        const windowStart = Date.now();
        const { context, teardown } = await createVmContext(
          state.entrypoint,
          state.features,
          {
            ...state.evalOptions.globals,
            __wyw_getModule: (moduleId) => getModuleData(moduleId),
          }
        );
        debug('init:context', Date.now() - windowStart);
        state.context = context;
        state.teardown = teardown;
        state.happyDomEnabled = nextHappyDomEnabled;

        sendMessage({ type: 'INIT_ACK', id: message.id });
        debug('init:done', Date.now() - initStart);
      } catch (error) {
        sendMessage({
          type: 'INIT_ACK',
          id: message.id,
          error: {
            message: error?.message ?? String(error),
            stack: error?.stack,
          },
        });
      }
      break;
    }
    case 'EVAL': {
      try {
        const { values, modules } = await evaluateEntrypoint(
          message.payload.id
        );
        sendMessage({
          type: 'EVAL_RESULT',
          id: message.id,
          payload: {
            values,
            modules,
          },
        });
      } catch (error) {
        sendMessage({
          type: 'EVAL_RESULT',
          id: message.id,
          payload: { values: null },
          error: {
            message: error?.message ?? String(error),
            stack: error?.stack,
          },
        });
      }
      break;
    }
    case 'RESOLVE_RESULT':
    case 'LOAD_RESULT': {
      resolvePending(message.id, message.payload);
      break;
    }
    default:
      break;
  }
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  lines.forEach((line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    handleMessage(message);
  });
});

process.stdin.on('close', () => {
  if (state.teardown) {
    state.teardown();
  }
  process.exit(0);
});
