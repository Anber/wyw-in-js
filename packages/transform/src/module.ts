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
import NativeModule, { createRequire } from 'module';
import path from 'path';
import * as vm from 'vm';
import { pathToFileURL } from 'url';

import { invariant } from 'ts-invariant';

import { isFeatureEnabled } from '@wyw-in-js/shared';
import type {
  Debugger,
  EvalOptionsV2,
  EvalResolverKind,
  EvalWarning,
  ImportLoaderContext,
  ImportLoaders,
} from '@wyw-in-js/shared';

import './utils/dispose-polyfill';
import type { TransformCacheCollection } from './cache';
import { Entrypoint } from './transform/Entrypoint';
import {
  getStack,
  isSuperSet,
  mergeOnly,
} from './transform/Entrypoint.helpers';
import type { IEvaluatedEntrypoint } from './transform/EvaluatedEntrypoint';
import type { IEntrypointDependency } from './transform/Entrypoint.types';
import { isUnprocessedEntrypointError } from './transform/actions/UnprocessedEntrypointError';
import type { Services } from './transform/types';
import {
  applyImportOverrideToOnly,
  getImportOverride,
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
const nodeRequire = createRequire(import.meta.url);

const NOOP = () => {};
const TROUBLESHOOTING_URL = 'https://wyw-in-js.dev/troubleshooting';

type ModuleData = {
  exports: Record<string | symbol, unknown>;
  module: { exports: Record<string | symbol, unknown> };
  require: ((id: string) => unknown) & {
    ensure: () => void;
    resolve: (id: string) => string;
  };
  filename: string;
  dirname: string;
  dynamicImport: (id: unknown) => Promise<unknown>;
};

type ResolvedImport = {
  source: string;
  resolved: string;
  only: string[];
  external?: boolean;
};

const defaultEvalOptions: Required<
  Pick<EvalOptionsV2, 'mode' | 'require' | 'resolver'>
> = {
  mode: 'strict',
  require: 'warn-and-run',
  resolver: 'bundler',
};

const browserOnlyEvalHintTriggers = [
  'window is not defined',
  "evaluating 'window",
  'document is not defined',
  "evaluating 'document",
  'navigator is not defined',
  "evaluating 'navigator",
  'self is not defined',
  "evaluating 'self",
];

const getBrowserOnlyEvalHint = (error: unknown): string | null => {
  const message = error instanceof Error ? error.message : String(error);
  const looksLikeBrowserOnly = browserOnlyEvalHintTriggers.some((trigger) =>
    message.includes(trigger)
  );
  if (!looksLikeBrowserOnly) return null;

  return [
    '',
    '[wyw-in-js] Evaluation hint:',
    'This usually means browser-only code ran during build-time evaluation.',
    'Move browser-only initialization out of evaluated modules, or mock the import via `importOverrides`.',
    "Example: importOverrides: { 'msw/browser': { mock: './src/__mocks__/msw-browser.js' } }",
    `Docs: ${TROUBLESHOOTING_URL}`,
  ].join('\n');
};

const warnedUnknownImportsByServices = new WeakMap<Services, Set<string>>();

const getEvalOptions = (services: Services): EvalOptionsV2 => ({
  ...defaultEvalOptions,
  ...(services.options.pluginOptions.eval ?? {}),
});

function emitWarning(services: Services, message: string) {
  if (services.emitWarning) {
    services.emitWarning(message);
    return;
  }

  // eslint-disable-next-line no-console
  console.warn(message);
}

function emitEvalWarning(services: Services, warning: EvalWarning) {
  const { onWarn } = getEvalOptions(services);
  onWarn?.(warning);
  emitWarning(services, warning.message);
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

const defaultImportLoaders: ImportLoaders = {
  raw: 'raw',
  url: 'url',
};

const buildModulePreamble = (id: string): string => {
  const payload = JSON.stringify(id);
  return [
    `const __wyw_module = __wyw_getModule(${payload});`,
    `let exports = __wyw_module.exports;`,
    `const module = __wyw_module.module;`,
    `const require = __wyw_module.require;`,
    `const __filename = __wyw_module.filename;`,
    `const __dirname = __wyw_module.dirname;`,
    `const __wyw_dynamic_import = __wyw_module.dynamicImport;`,
    ``,
  ].join('\n');
};

const applyModuleNamespace = (
  entrypointExports: Record<string | symbol, unknown>,
  module: vm.Module,
  moduleData: ModuleData
): Record<string | symbol, unknown> => {
  const { namespace } = module;
  const keys = Object.keys(namespace);

  if (keys.length === 0 && moduleData.module.exports !== moduleData.exports) {
    return moduleData.module.exports as Record<string | symbol, unknown>;
  }

  const nextExports = entrypointExports;
  keys.forEach((key) => {
    nextExports[key] = (namespace as Record<string, unknown>)[key];
  });

  return nextExports;
};

const ensureVmModules = (): void => {
  if (!vm.SourceTextModule || !vm.SyntheticModule) {
    throw new EvalError(
      '[wyw-in-js] vm.SourceTextModule is not available in this runtime. ' +
        'WyW v2 uses a separate eval runner process for ESM evaluation.'
    );
  }
};

const getImporterDependency = (
  importer: Entrypoint | IEvaluatedEntrypoint,
  specifier: string
): IEntrypointDependency | undefined => {
  if (importer instanceof Entrypoint) {
    return importer.getDependency(specifier);
  }

  return importer.dependencies.get(specifier);
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
    (id: string) => this.requireWithFallback(id, this.entrypoint),
    {
      ensure: NOOP,
      resolve: (id: string) =>
        this.resolveRequire(id, this.entrypoint).resolved,
    }
  );

  public resolve = (id: string) =>
    this.resolveRequire(id, this.entrypoint).resolved;

  private cache: TransformCacheCollection;

  private context: vm.Context | null = null;

  private teardown: (() => void) | null = null;

  private moduleCache = new Map<string, vm.Module>();

  private moduleEntrypoints = new WeakMap<
    vm.Module,
    Entrypoint | IEvaluatedEntrypoint
  >();

  private moduleLinkPromises = new WeakMap<vm.Module, Promise<void>>();

  private moduleData = new Map<string, ModuleData>();

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

  async evaluate(): Promise<void> {
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

    const { teardown } = await this.ensureContext(filename);
    try {
      const module = await this.getModuleForEntrypoint(entrypoint);
      await this.linkModule(module);
      await module.evaluate();
      const exports = applyModuleNamespace(
        entrypoint.exports as Record<string | symbol, unknown>,
        module,
        this.getModuleData(entrypoint.name)
      );
      if (exports !== entrypoint.exports) {
        entrypoint.exports = exports;
      }
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
      const baseMessage = `${(e as Error).message} in${this.callstack.join(
        '\n| '
      )}\n`;
      const hint = getBrowserOnlyEvalHint(e);

      throw new EvalError(hint ? `${baseMessage}${hint}\n` : baseMessage);
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
    let reprocessOnly: string[] = only;
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

      if (entrypoint.evaluatedOnly?.length) {
        reprocessOnly = mergeOnly(evaluatedExports, only);
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
    const newEntrypoint = Entrypoint.createRoot(
      this.services,
      filename,
      reprocessOnly,
      code
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

  private async ensureContext(filename: string) {
    if (this.context && this.teardown) {
      return { context: this.context, teardown: this.teardown };
    }

    const evalOptions = getEvalOptions(this.services);
    const { context, teardown } = await createVmContext(
      filename,
      this.services.options.pluginOptions.features,
      {
        ...(evalOptions.globals ?? {}),
        __wyw_getModule: (id: string) => this.getModuleData(id),
      },
      this.services.options.pluginOptions.overrideContext
    );

    this.context = context;
    this.teardown = () => {
      teardown();
      this.context = null;
      this.teardown = null;
    };

    return { context: this.context, teardown: this.teardown };
  }

  private getModuleData(id: string): ModuleData {
    const data = this.moduleData.get(id);
    invariant(data, `Missing module data for ${id}`);
    return data;
  }

  private createModuleData(
    id: string,
    entrypoint?: Entrypoint | IEvaluatedEntrypoint
  ): ModuleData {
    const cached = this.moduleData.get(id);
    if (cached) return cached;

    const exporter = entrypoint ?? this.entrypoint;
    const exportsProxy =
      entrypoint && 'exports' in entrypoint
        ? entrypoint.exports
        : ({} as Record<string | symbol, unknown>);
    const moduleObj = { exports: exportsProxy };

    const requireFn = Object.assign(
      (request: string) => this.requireWithFallback(request, exporter),
      {
        ensure: NOOP,
        resolve: (request: string) =>
          this.resolveRequire(request, exporter).resolved,
      }
    );

    const filename = stripQueryAndHash(id);
    const data: ModuleData = {
      exports: exportsProxy,
      module: moduleObj,
      require: requireFn,
      filename,
      dirname: path.dirname(filename),
      dynamicImport: (request: unknown) =>
        this.dynamicImportFrom(exporter, request),
    };

    this.moduleData.set(id, data);
    return data;
  }

  private async createSourceTextModule(
    id: string,
    code: string,
    entrypoint?: Entrypoint | IEvaluatedEntrypoint
  ): Promise<vm.SourceTextModule> {
    ensureVmModules();
    const { context } = await this.ensureContext(stripQueryAndHash(id));
    this.createModuleData(id, entrypoint);

    const module = new vm.SourceTextModule(
      `${buildModulePreamble(id)}${code}`,
      {
        context,
        identifier: id,
        initializeImportMeta: (meta: ImportMeta, targetModule: vm.Module) => {
          const identifier =
            typeof targetModule.identifier === 'string'
              ? targetModule.identifier
              : id;
          const fileId = stripQueryAndHash(identifier);
          Object.assign(meta, {
            url: path.isAbsolute(fileId) ? pathToFileURL(fileId).href : fileId,
          });
        },
        importModuleDynamically: (
          specifier: string,
          referencingModule: vm.Module
        ) => this.importModuleDynamically(specifier, referencingModule),
      }
    );

    this.moduleCache.set(id, module);
    if (entrypoint) {
      this.moduleEntrypoints.set(module, entrypoint);
    }

    return module;
  }

  private async createSyntheticModule(
    id: string,
    exportsValue: Record<string, unknown>
  ): Promise<vm.SyntheticModule> {
    ensureVmModules();
    const { context } = await this.ensureContext(stripQueryAndHash(id));
    const exportNames = new Set(Object.keys(exportsValue));
    const hasDefault = Object.prototype.hasOwnProperty.call(
      exportsValue,
      'default'
    );
    if (!exportNames.has('default')) {
      exportNames.add('default');
    }

    const module = new vm.SyntheticModule(
      [...exportNames],
      function init(this: vm.SyntheticModule) {
        exportNames.forEach((key) => {
          const value =
            key === 'default' && !hasDefault ? exportsValue : exportsValue[key];
          this.setExport(key, value);
        });
      },
      { context, identifier: id }
    );

    this.moduleCache.set(id, module);
    return module;
  }

  private async getVirtualModule(specifier: string): Promise<vm.Module | null> {
    if (specifier === REACT_REFRESH_VIRTUAL_ID) {
      return this.createSyntheticModule(specifier, {
        createSignatureFunctionForTransform:
          reactRefreshRuntime.createSignatureFunctionForTransform,
      });
    }

    if (specifier.startsWith(VITE_VIRTUAL_PREFIX)) {
      return this.createSyntheticModule(specifier, { default: {} });
    }

    if (specifier.startsWith('virtual:')) {
      return this.createSyntheticModule(specifier, { default: {} });
    }

    return null;
  }

  private async getModuleForEntrypoint(
    entrypoint: Entrypoint | IEvaluatedEntrypoint
  ): Promise<vm.Module> {
    const cached = this.moduleCache.get(entrypoint.name);
    if (cached) return cached;

    if (!(entrypoint instanceof Entrypoint)) {
      return this.createSyntheticModule(entrypoint.name, entrypoint.exports);
    }

    entrypoint.assertTransformed();
    const source = entrypoint.transformedCode ?? '';

    return this.createSourceTextModule(entrypoint.name, source, entrypoint);
  }

  private async linkModule(module: vm.Module): Promise<void> {
    const cached = this.moduleLinkPromises.get(module);
    if (cached) {
      await cached;
      return;
    }

    if (module.status !== 'unlinked') {
      return;
    }

    const linking = module.link((specifier, referencingModule) =>
      this.getModuleForSpecifier(specifier, referencingModule, 'import')
    );
    this.moduleLinkPromises.set(module, linking);
    await linking;
  }

  private async importModuleDynamically(
    specifier: string,
    referencingModule: vm.Module
  ): Promise<vm.Module> {
    const module = await this.getModuleForSpecifier(
      specifier,
      referencingModule,
      'dynamic-import'
    );
    await this.linkModule(module);
    if (module.status === 'linked') {
      await module.evaluate();
    }
    return module;
  }

  private async dynamicImportFrom(
    importer: Entrypoint | IEvaluatedEntrypoint,
    id: unknown
  ): Promise<unknown> {
    const specifier = String(id);
    const module = await this.getModuleForSpecifierFromEntrypoint(
      specifier,
      importer,
      'dynamic-import'
    );
    await this.linkModule(module);
    if (module.status === 'linked') {
      await module.evaluate();
    }
    return module.namespace;
  }

  private async getModuleForSpecifier(
    specifier: string,
    referencingModule: vm.Module,
    kind: EvalResolverKind
  ): Promise<vm.Module> {
    const importer =
      this.moduleEntrypoints.get(referencingModule) ?? this.entrypoint;
    return this.getModuleForSpecifierFromEntrypoint(specifier, importer, kind);
  }

  private async getModuleForSpecifierFromEntrypoint(
    specifier: string,
    importer: Entrypoint | IEvaluatedEntrypoint,
    kind: EvalResolverKind
  ): Promise<vm.Module> {
    const virtualModule = await this.getVirtualModule(specifier);
    if (virtualModule) {
      return virtualModule;
    }

    this.dependencies.push(specifier);

    const resolved = await this.resolveImport(specifier, importer, kind);
    const evalOptions = getEvalOptions(this.services);

    if (!resolved) {
      if (evalOptions.mode === 'loose') {
        return this.createSyntheticModule(specifier, { default: undefined });
      }

      throw new Error(
        [
          `[wyw-in-js] Unable to resolve "${specifier}" during evaluation.`,
          ``,
          `importer: ${importer.name}`,
          `hint: check eval.resolver/customResolver or add importOverrides for this specifier.`,
          `docs: ${TROUBLESHOOTING_URL}`,
        ].join('\n')
      );
    }

    if (resolved.external) {
      return this.createSyntheticModule(resolved.resolved, {
        default: undefined,
      });
    }

    return this.getModuleForResolved(resolved, importer);
  }

  private async resolveImport(
    specifier: string,
    importer: Entrypoint | IEvaluatedEntrypoint,
    kind: EvalResolverKind
  ): Promise<ResolvedImport | null> {
    const evalOptions = getEvalOptions(this.services);

    if (evalOptions.customResolver) {
      const customResolved = await evalOptions.customResolver(
        specifier,
        importer.name,
        kind
      );
      if (customResolved) {
        return this.applyImportOverrides(
          {
            source: specifier,
            resolved: customResolved.id,
            only: ['*'],
            external: customResolved.external,
          },
          importer
        );
      }

      if (evalOptions.resolver === 'custom') {
        return null;
      }
    }

    if (evalOptions.resolver !== 'node') {
      const dependency = getImporterDependency(importer, specifier);
      if (dependency?.resolved) {
        return {
          source: specifier,
          resolved: dependency.resolved,
          only: dependency.only,
        };
      }
    }

    if (evalOptions.resolver === 'node' || evalOptions.require !== 'off') {
      return this.resolveWithNodeFallback(specifier, importer, kind);
    }

    return null;
  }

  private resolveRequire(
    specifier: string,
    importer: Entrypoint | IEvaluatedEntrypoint
  ): ResolvedImport {
    const dependency = getImporterDependency(importer, specifier);
    if (dependency?.resolved) {
      return this.applyImportOverrides(
        {
          source: specifier,
          resolved: dependency.resolved,
          only: dependency.only,
        },
        importer
      );
    }

    return this.resolveWithNodeFallback(specifier, importer, 'require');
  }

  private applyImportOverrides(
    resolved: ResolvedImport,
    importer: Entrypoint | IEvaluatedEntrypoint
  ): ResolvedImport {
    const { root } = this.services.options;
    const keyInfo = toImportKey({
      source: resolved.source,
      resolved: resolved.resolved,
      root,
    });
    const override = getImportOverride(
      this.services.options.pluginOptions.importOverrides,
      keyInfo.key
    );

    if (!override) {
      return resolved;
    }

    let nextResolved = resolved.resolved;
    if (override.mock) {
      nextResolved = resolveMockSpecifier({
        mock: override.mock,
        importer: importer.name,
        root,
        stack: getStack(importer),
      });
    }

    return {
      ...resolved,
      resolved: nextResolved,
      only: applyImportOverrideToOnly(resolved.only, override),
    };
  }

  private async getModuleForResolved(
    resolved: ResolvedImport,
    importer: Entrypoint | IEvaluatedEntrypoint
  ): Promise<vm.Module> {
    const cached = this.moduleCache.get(resolved.resolved);
    if (cached) return cached;

    const evalOptions = getEvalOptions(this.services);

    if (evalOptions.customLoader) {
      const loaded = await evalOptions.customLoader(resolved.resolved);
      if (loaded) {
        if (loaded.loader === 'json') {
          const jsonValue = JSON.parse(loaded.code);
          return this.createSyntheticModule(resolved.resolved, {
            default: jsonValue,
          });
        }

        if (loaded.loader === 'raw' || loaded.loader === 'text') {
          return this.createSyntheticModule(resolved.resolved, {
            default: loaded.code,
          });
        }

        return this.createSourceTextModule(
          resolved.resolved,
          loaded.code,
          importer
        );
      }
    }

    const loaded = this.loadByImportLoaders(
      resolved.source,
      resolved.resolved,
      importer.name
    );
    if (loaded.handled) {
      return this.createSyntheticModule(resolved.resolved, {
        default: loaded.value,
      });
    }

    const stripped = stripQueryAndHash(resolved.resolved);
    if (stripped.endsWith('.json')) {
      const jsonSource = fs.readFileSync(stripped, 'utf-8');
      return this.createSyntheticModule(resolved.resolved, {
        default: JSON.parse(jsonSource),
      });
    }

    const entrypoint = this.getEntrypoint(
      resolved.resolved,
      resolved.only,
      importer.log
    );

    if (!entrypoint) {
      return this.createSyntheticModule(resolved.resolved, {
        default: resolved.resolved,
      });
    }

    if ('evaluated' in entrypoint && entrypoint.evaluated) {
      return this.createSyntheticModule(entrypoint.name, entrypoint.exports);
    }

    return this.getModuleForEntrypoint(entrypoint);
  }

  resolveWithNodeFallback = (
    id: string,
    importer: Entrypoint | IEvaluatedEntrypoint,
    kind: EvalResolverKind
  ): ResolvedImport => {
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

      const filename = importer.name;
      const strippedId = stripQueryAndHash(id);

      let resolved = this.moduleImpl._resolveFilename(strippedId, {
        id: filename,
        filename,
        paths: this.moduleImpl._nodeModulePaths(path.dirname(filename)),
      });

      const isFileSpecifier =
        strippedId.startsWith('.') || path.isAbsolute(strippedId);

      if (
        isFileSpecifier &&
        path.extname(strippedId) === '' &&
        resolved.endsWith('.cjs') &&
        fs.existsSync(`${resolved.slice(0, -4)}.js`)
      ) {
        // When both `.cjs` and `.js` exist for an extensionless specifier, the
        // resolver may pick `.cjs` depending on the environment/extensions.
        // Prefer `.js` to keep resolved paths stable (e.g. importOverrides keys).
        resolved = `${resolved.slice(0, -4)}.js`;
      }

      const { root } = this.services.options;
      const keyInfo = toImportKey({
        source: id,
        resolved,
        root,
      });

      const override = getImportOverride(
        this.services.options.pluginOptions.importOverrides,
        keyInfo.key
      );

      const evalOptions = getEvalOptions(this.services);
      const basePolicy: 'warn' | 'error' =
        evalOptions.require === 'warn-and-run' ? 'warn' : 'error';
      let policy = override?.unknown ?? (override?.mock ? 'allow' : basePolicy);
      if (evalOptions.require === 'off' && policy !== 'error') {
        policy = 'error';
      }
      const shouldWarn = !this.ignored && policy === 'warn';

      let finalResolved = resolved;
      if (override?.mock) {
        try {
          finalResolved = resolveMockSpecifier({
            mock: override.mock,
            importer: filename,
            root,
            stack: getStack(importer),
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
            ...getStack(importer).map((item) => `  ${item}`),
            ``,
            `config key: ${keyInfo.key}`,
            `docs: ${TROUBLESHOOTING_URL}`,
          ]
            .filter(Boolean)
            .join('\n')
        );
      }

      const warnedUnknownImports = getWarnedUnknownImports(this.services);

      if (shouldWarn && !warnedUnknownImports.has(keyInfo.key)) {
        warnedUnknownImports.add(keyInfo.key);
        const warningMessage = [
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
          ...getStack(importer).map((item) => `  ${item}`),
          ``,
          `config key: ${keyInfo.key}`,
          `hint: add { importOverrides: { ${JSON.stringify(
            keyInfo.key
          )}: { unknown: 'allow' } } } to silence warnings, or use { mock } / { noShake: true } overrides.`,
          `docs: ${TROUBLESHOOTING_URL}`,
        ]
          .filter(Boolean)
          .join('\n');

        emitEvalWarning(this.services, {
          code: kind === 'require' ? 'require-fallback' : 'resolve-fallback',
          message: warningMessage,
          importer: filename,
          specifier: id,
          resolved: resolved ?? null,
          callstack: getStack(importer),
          hint: `Use importOverrides or eval.require settings to avoid fallback.`,
        });
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

  private requireWithFallback(
    id: string,
    importer: Entrypoint | IEvaluatedEntrypoint
  ): unknown {
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

    const normalizedId = id.startsWith('node:') ? id.slice(5) : id;
    if (
      NativeModule.builtinModules?.includes(normalizedId) ||
      NativeModule.builtinModules?.includes(`node:${normalizedId}`)
    ) {
      if (normalizedId in builtins) {
        if (builtins[normalizedId as keyof typeof builtins]) {
          this.debug('require', `builtin '${normalizedId}'`);
          return nodeRequire(normalizedId);
        }

        return null;
      }

      throw new Error(
        `Unable to import "${normalizedId}". Importing Node builtins is not supported in the sandbox.`
      );
    }

    const dependency = this.resolveRequire(id, importer);

    const loaded = this.loadByImportLoaders(
      id,
      dependency.resolved,
      importer.name
    );
    if (loaded.handled) {
      this.dependencies.push(id);
      this.debug('require', `${id} -> ${dependency.resolved} (loader)`);
      return loaded.value;
    }

    const stripped = stripQueryAndHash(dependency.resolved);
    const extension = path.extname(stripped);
    if (
      extension &&
      extension !== '.json' &&
      !this.extensions.includes(extension)
    ) {
      this.dependencies.push(id);
      this.debug('require', `${id} -> ${dependency.resolved} (asset)`);
      return stripped;
    }

    if (this.services.cache.consumeInvalidation(dependency.resolved)) {
      delete nodeRequire.cache[dependency.resolved];
    }

    this.dependencies.push(id);
    this.debug('require', `${id} -> ${dependency.resolved}`);

    return nodeRequire(dependency.resolved);
  }

  protected createChild(entrypoint: Entrypoint): Module {
    return new Module(this.services, entrypoint, this, this.moduleImpl);
  }

  private loadByImportLoaders(
    request: string,
    resolved: string,
    importer: string
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
    const importerFilename = stripQueryAndHash(importer);
    const importerDir = path.dirname(importerFilename);

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
      importer: importerFilename,
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
