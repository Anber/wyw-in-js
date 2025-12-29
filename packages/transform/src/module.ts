/**
 * This is a custom implementation for the module system for evaluating code,
 * used for resolving values for dependencies interpolated in `css` or `styled`.
 *
 * This serves 2 purposes:
 * - Avoid leakage from evaluated code to module cache in current context, e.g. `babel-register`
 * - Allow us to invalidate the module cache without affecting other stuff, necessary for rebuilds
 *
 * We also use it to transpile the code with Babel by default.
 * We also store source maps for it to provide correct error stacktraces.
 *
 */

import fs from 'fs';
import NativeModule from 'module';
import path from 'path';
import vm from 'vm';

import { invariant } from 'ts-invariant';

import {
  isFeatureEnabled,
  type Debugger,
  type ImportLoaderContext,
  type ImportLoaders,
} from '@wyw-in-js/shared';

import './utils/dispose-polyfill';
import type { TransformCacheCollection } from './cache';
import { Entrypoint } from './transform/Entrypoint';
import { getStack, isSuperSet } from './transform/Entrypoint.helpers';
import type { IEntrypointDependency } from './transform/Entrypoint.types';
import type { IEvaluatedEntrypoint } from './transform/EvaluatedEntrypoint';
import { isUnprocessedEntrypointError } from './transform/actions/UnprocessedEntrypointError';
import type { Services } from './transform/types';
import {
  applyImportOverrideToOnly,
  resolveMockSpecifier,
  toImportKey,
} from './utils/importOverrides';
import { parseRequest, stripQueryAndHash } from './utils/parseRequest';
import { createVmContext } from './vm/createVmContext';

type HiddenModuleMembers = {
  _extensions: Record<string, () => void>;
  _resolveFilename: (
    id: string,
    options: { filename: string; id: string; paths: string[] }
  ) => string;
  _nodeModulePaths(filename: string): string[];
};

export const DefaultModuleImplementation = NativeModule as typeof NativeModule &
  HiddenModuleMembers;

// Supported node builtins based on the modules polyfilled by webpack
// `true` means module is polyfilled, `false` means module is empty
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

const VITE_VIRTUAL_PREFIX = '/@';
const REACT_REFRESH_VIRTUAL_ID = '/@react-refresh';
const reactRefreshRuntime = {
  createSignatureFunctionForTransform: () => () => {},
};

const NOOP = () => {};

const warnedUnknownImportsByServices = new WeakMap<Services, Set<string>>();

function emitWarning(services: Services, message: string) {
  if (services.emitWarning) {
    services.emitWarning(message);
    return;
  }

  // eslint-disable-next-line no-console
  console.warn(message);
}

function getWarnedUnknownImports(services: Services): Set<string> {
  const cached = warnedUnknownImportsByServices.get(services);
  if (cached) {
    return cached;
  }

  const created = new Set<string>();
  warnedUnknownImportsByServices.set(services, created);
  return created;
}

function getUncached(cached: string | string[], test: string[]): string[] {
  const cachedSet = new Set(
    typeof cached === 'string' ? cached.split(',') : cached
  );

  if (cachedSet.has('*')) {
    return [];
  }

  return test.filter((t) => !cachedSet.has(t));
}

function resolve(
  this: { resolveDependency: (id: string) => IEntrypointDependency },
  id: string
): string {
  const { resolved } = this.resolveDependency(id);
  invariant(resolved, `Unable to resolve "${id}"`);
  return resolved;
}

const defaultImportLoaders: ImportLoaders = {
  raw: 'raw',
  url: 'url',
};

export class Module {
  public readonly callstack: string[] = [];

  public readonly debug: Debugger;

  public readonly dependencies: string[];

  public readonly extensions: string[];

  public readonly filename: string;

  public id: string;

  public readonly idx: string;

  public readonly ignored: boolean;

  public isEvaluated: boolean = false;

  public readonly parentIsIgnored: boolean;

  public require: {
    (id: string): unknown;
    ensure: () => void;
    resolve: (id: string) => string;
  } = Object.assign(
    (id: string) => {
      if (id === REACT_REFRESH_VIRTUAL_ID) {
        this.dependencies.push(id);
        this.debug('require', `vite virtual '${id}'`);
        return reactRefreshRuntime;
      }

      if (id.startsWith(VITE_VIRTUAL_PREFIX)) {
        this.dependencies.push(id);
        this.debug('require', `vite virtual '${id}'`);
        return {};
      }

      if (id in builtins) {
        // The module is in the allowed list of builtin node modules
        // Ideally we should prevent importing them, but webpack polyfills some
        // So we check for the list of polyfills to determine which ones to support
        if (builtins[id as keyof typeof builtins]) {
          this.debug('require', `builtin '${id}'`);
          return require(id);
        }

        return null;
      }

      // Resolve module id (and filename) relatively to parent module
      const dependency = this.resolveDependency(id);
      if (dependency.resolved === id && !path.isAbsolute(id)) {
        // The module is a builtin node modules, but not in the allowed list
        throw new Error(
          `Unable to import "${id}". Importing Node builtins is not supported in the sandbox.`
        );
      }

      invariant(
        dependency.resolved,
        `Dependency ${dependency.source} cannot be resolved`
      );

      const loaded = this.loadByImportLoaders(id, dependency.resolved);
      if (loaded.handled) {
        this.dependencies.push(id);
        this.debug('require', `${id} -> ${dependency.resolved} (loader)`);
        return loaded.value;
      }

      this.dependencies.push(id);

      this.debug('require', `${id} -> ${dependency.resolved}`);

      const entrypoint = this.getEntrypoint(
        dependency.resolved,
        dependency.only,
        this.debug
      );

      if (entrypoint === null) {
        return dependency.resolved;
      }

      if (
        entrypoint.evaluated ||
        isSuperSet(entrypoint.evaluatedOnly, dependency.only)
      ) {
        return entrypoint.exports;
      }

      const m = this.createChild(entrypoint);
      m.evaluate();

      return entrypoint.exports;
    },
    {
      ensure: NOOP,
      resolve: resolve.bind(this),
    }
  );

  public resolve = resolve.bind(this);

  private cache: TransformCacheCollection;

  #entrypointRef: WeakRef<Entrypoint> | Entrypoint;

  constructor(
    private services: Services,
    entrypoint: Entrypoint,
    parentModule?: Module,
    private moduleImpl: HiddenModuleMembers = DefaultModuleImplementation
  ) {
    this.cache = services.cache;
    this.#entrypointRef = isFeatureEnabled(
      services.options.pluginOptions.features,
      'useWeakRefInEval',
      entrypoint.name
    )
      ? new WeakRef(entrypoint)
      : entrypoint;
    this.idx = entrypoint.idx;
    this.id = entrypoint.name;
    this.filename = entrypoint.name;
    this.dependencies = [];
    this.debug = entrypoint.log.extend('module');
    this.parentIsIgnored = parentModule?.ignored ?? false;
    this.ignored = entrypoint.ignored ?? this.parentIsIgnored;

    if (parentModule) {
      this.callstack = [entrypoint.name, ...parentModule.callstack];
    } else {
      this.callstack = [entrypoint.name];
    }

    this.extensions = services.options.pluginOptions.extensions;

    this.debug('init', entrypoint.name);
  }

  public get exports() {
    return this.entrypoint.exports;
  }

  public set exports(value) {
    this.entrypoint.exports = value;

    this.debug('the whole exports was overridden with %O', value);
  }

  protected get entrypoint(): Entrypoint {
    const entrypoint =
      this.#entrypointRef instanceof WeakRef
        ? this.#entrypointRef.deref()
        : this.#entrypointRef;
    invariant(entrypoint, `Module ${this.idx} is disposed`);
    return entrypoint;
  }

  evaluate(): void {
    const { entrypoint } = this;
    entrypoint.assertTransformed();

    const cached = this.cache.get('entrypoints', entrypoint.name)!;
    let evaluatedCreated = false;
    if (!entrypoint.supersededWith) {
      this.cache.add(
        'entrypoints',
        entrypoint.name,
        entrypoint.createEvaluated()
      );
      evaluatedCreated = true;
    }

    const { transformedCode: source } = entrypoint;
    const { pluginOptions } = this.services.options;

    if (!source) {
      this.debug(`evaluate`, 'there is nothing to evaluate');
      return;
    }

    if (this.isEvaluated) {
      this.debug('evaluate', `is already evaluated`);
      return;
    }

    this.debug('evaluate');
    this.debug.extend('source')('%s', source);

    this.isEvaluated = true;

    const filename = stripQueryAndHash(this.filename);

    if (/\.json$/.test(filename)) {
      // For JSON files, parse it to a JS object similar to Node
      this.exports = JSON.parse(source);
      return;
    }

    const { context, teardown } = createVmContext(
      filename,
      pluginOptions.features,
      {
        module: this,
        exports: entrypoint.exports,
        require: this.require,
        __wyw_dynamic_import: async (id: unknown) => this.require(String(id)),
        __dirname: path.dirname(filename),
      },
      pluginOptions.overrideContext
    );

    try {
      const script = new vm.Script(
        `(function (exports) { ${source}\n})(exports);`,
        {
          filename,
        }
      );

      script.runInContext(context);
    } catch (e) {
      this.isEvaluated = false;
      if (evaluatedCreated) {
        this.cache.add('entrypoints', entrypoint.name, cached);
      }

      if (isUnprocessedEntrypointError(e)) {
        // It will be handled by evalFile scenario
        throw e;
      }

      if (e instanceof EvalError) {
        this.debug('%O', e);

        throw e;
      }

      this.debug('%O\n%O', e, this.callstack);
      throw new EvalError(
        `${(e as Error).message} in${this.callstack.join('\n| ')}\n`
      );
    } finally {
      teardown();
    }
  }

  getEntrypoint(
    filename: string,
    only: string[],
    log: Debugger
  ): Entrypoint | IEvaluatedEntrypoint | null {
    const strippedFilename = stripQueryAndHash(filename);
    const extension = path.extname(strippedFilename);
    if (extension !== '.json' && !this.extensions.includes(extension)) {
      return null;
    }

    const entrypoint = this.cache.get('entrypoints', filename);
    if (entrypoint && isSuperSet(entrypoint.evaluatedOnly ?? [], only)) {
      log('✅ file has been already evaluated');
      return entrypoint;
    }

    if (entrypoint?.ignored) {
      log(
        '✅ file has been ignored during prepare stage. Original code will be used'
      );
      return entrypoint;
    }

    if (this.ignored) {
      log(
        '✅ one of the parent files has been ignored during prepare stage. Original code will be used'
      );

      const newEntrypoint = this.entrypoint.createChild(
        filename,
        ['*'],
        fs.readFileSync(strippedFilename, 'utf-8')
      );

      if (newEntrypoint === 'loop') {
        const stack = getStack(this.entrypoint);
        throw new Error(
          `Circular dependency detected: ${stack.join(' -> ')} -> ${filename}`
        );
      }

      return newEntrypoint;
    }

    let uncachedExports: string[] | null = null;
    // Requested file can be already prepared for evaluation on the stage 1
    if (only && entrypoint) {
      const evaluatedExports =
        entrypoint.evaluatedOnly?.length !== 0
          ? entrypoint.evaluatedOnly
          : entrypoint.only ?? [];
      uncachedExports = getUncached(evaluatedExports, only);
      if (uncachedExports.length === 0) {
        log('✅ ready for evaluation');
        return entrypoint;
      }

      log(
        '❌ file has been processed during prepare stage but %o is not evaluated yet (evaluated: %o)',
        uncachedExports,
        evaluatedExports
      );
    } else {
      log('❌ file has not been processed during prepare stage');
    }

    // If code wasn't extracted from cache, it indicates that we were unable
    // to process some of the imports on stage1. Let's try to reprocess.
    const code = fs.readFileSync(strippedFilename, 'utf-8');
    const shouldSkipCacheOnlyMerge = Boolean(
      uncachedExports && entrypoint?.evaluatedOnly?.length
    );
    const newEntrypoint = Entrypoint.createRoot(
      this.services,
      filename,
      uncachedExports ?? only,
      code,
      shouldSkipCacheOnlyMerge ? { skipCacheOnlyMerge: true } : undefined
    );

    if (newEntrypoint.evaluated) {
      log('✅ file has been already evaluated');
      return newEntrypoint;
    }

    if (newEntrypoint.ignored) {
      log(
        '✅ file has been ignored during prepare stage. Original code will be used'
      );
      return newEntrypoint;
    }

    return newEntrypoint;
  }

  resolveDependency = (id: string): IEntrypointDependency => {
    const cached = this.entrypoint.getDependency(id);
    invariant(!(cached instanceof Promise), 'Dependency is not resolved yet');

    if (cached) {
      return cached;
    }

    if (!this.ignored) {
      this.debug(
        '❌ import has not been resolved during prepare stage. Fallback to Node.js resolver'
      );
    }

    const extensions = this.moduleImpl._extensions;
    const added: string[] = [];

    try {
      // Check for supported extensions
      this.extensions.forEach((ext) => {
        if (ext in extensions) {
          return;
        }

        // When an extension is not supported, add it
        // And keep track of it to clean it up after resolving
        // Use noop for the transform function since we handle it
        extensions[ext] = NOOP;
        added.push(ext);
      });

      const { filename } = this;
      const strippedId = stripQueryAndHash(id);

      const resolved = this.moduleImpl._resolveFilename(strippedId, {
        id: filename,
        filename,
        paths: this.moduleImpl._nodeModulePaths(path.dirname(filename)),
      });

      const { root } = this.services.options;
      const keyInfo = toImportKey({
        source: id,
        resolved,
        root,
      });

      const override =
        this.services.options.pluginOptions.importOverrides?.[keyInfo.key];

      const policy = override?.unknown ?? (override?.mock ? 'allow' : 'warn');
      const shouldWarn = !this.ignored && policy === 'warn';

      let finalResolved = resolved;
      if (override?.mock) {
        try {
          finalResolved = resolveMockSpecifier({
            mock: override.mock,
            importer: filename,
            root,
            stack: this.callstack,
          });
        } catch (e) {
          const errorMessage = String((e as Error)?.message ?? e);
          throw new Error(
            `[wyw-in-js] Failed to resolve import mock for "${keyInfo.key}" (${id} from ${filename}): ${errorMessage}`
          );
        }
      }

      if (policy === 'error') {
        throw new Error(
          [
            `[wyw-in-js] Unknown import reached during eval (Node resolver fallback)`,
            ``,
            `importer: ${filename}`,
            `source:   ${id}`,
            `resolved: ${resolved}`,
            override?.mock
              ? `mock:     ${override.mock} -> ${finalResolved}`
              : ``,
            ``,
            `callstack:`,
            ...this.callstack.map((item) => `  ${item}`),
            ``,
            `config key: ${keyInfo.key}`,
          ]
            .filter(Boolean)
            .join('\n')
        );
      }

      const warnedUnknownImports = getWarnedUnknownImports(this.services);

      if (shouldWarn && !warnedUnknownImports.has(keyInfo.key)) {
        warnedUnknownImports.add(keyInfo.key);
        emitWarning(
          this.services,
          [
            `[wyw-in-js] Unknown import reached during eval (Node resolver fallback)`,
            ``,
            `importer: ${filename}`,
            `source:   ${id}`,
            `resolved: ${resolved}`,
            override?.mock
              ? `mock:     ${override.mock} -> ${finalResolved}`
              : ``,
            ``,
            `callstack:`,
            ...this.callstack.map((item) => `  ${item}`),
            ``,
            `config key: ${keyInfo.key}`,
            `hint: add { importOverrides: { ${JSON.stringify(
              keyInfo.key
            )}: { unknown: 'allow' } } } to silence warnings, or use { mock } / { noShake: true } overrides.`,
          ]
            .filter(Boolean)
            .join('\n')
        );
      }

      return {
        source: id,
        only: applyImportOverrideToOnly(['*'], override),
        resolved: finalResolved,
      };
    } finally {
      // Cleanup the extensions we added to restore previous behaviour
      added.forEach((ext) => delete extensions[ext]);
    }
  };

  protected createChild(entrypoint: Entrypoint): Module {
    return new Module(this.services, entrypoint, this, this.moduleImpl);
  }

  private loadByImportLoaders(
    request: string,
    resolved: string
  ): { handled: boolean; value: unknown } {
    const { pluginOptions } = this.services.options;
    const importLoaders =
      pluginOptions.importLoaders === undefined
        ? defaultImportLoaders
        : { ...defaultImportLoaders, ...pluginOptions.importLoaders };

    const { query, hash } = parseRequest(request);
    if (!query) return { handled: false, value: undefined };

    const params = new URLSearchParams(query);
    const matchedKey = Array.from(params.keys()).find(
      (key) => importLoaders[key] !== undefined && importLoaders[key] !== false
    );

    if (!matchedKey) return { handled: false, value: undefined };

    const loader = importLoaders[matchedKey];

    const filename = stripQueryAndHash(resolved);
    const importer = stripQueryAndHash(this.filename);
    const importerDir = path.dirname(importer);

    const toUrl = () => {
      const relative = path
        .relative(importerDir, filename)
        .replace(/\\/g, path.posix.sep);

      if (relative.startsWith('.') || path.isAbsolute(relative)) {
        return relative;
      }

      return `./${relative}`;
    };

    const readFile = () => fs.readFileSync(filename, 'utf-8');

    const context: ImportLoaderContext = {
      importer,
      request,
      resolved,
      filename,
      query,
      hash,
      emitWarning: (message) => emitWarning(this.services, message),
      readFile,
      toUrl,
    };

    if (loader === 'raw') {
      return { handled: true, value: context.readFile() };
    }

    if (loader === 'url') {
      return { handled: true, value: context.toUrl() };
    }

    if (typeof loader === 'function') {
      return { handled: true, value: loader(context) };
    }

    return { handled: false, value: undefined };
  }
}
