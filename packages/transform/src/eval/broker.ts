import { createHash } from 'crypto';
import fs from 'fs';
import NativeModule from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

import { invariant } from 'ts-invariant';

import type {
  EvalOptionsV2,
  EvalWarning,
  FeatureFlags,
  ImportLoaderContext,
  ImportLoaders,
} from '@wyw-in-js/shared';
import { isFeatureEnabled } from '@wyw-in-js/shared';

import type { Entrypoint } from '../transform/Entrypoint';
import type { Services } from '../transform/types';
import {
  applyImportOverrideToOnly,
  getImportOverride,
  resolveMockSpecifier,
  toImportKey,
} from '../utils/importOverrides';
import { parseRequest, stripQueryAndHash } from '../utils/parseRequest';
import { isSuperSet, mergeOnly } from '../transform/Entrypoint.helpers';

import {
  type EvalRunnerInitPayload,
  type EvalResultPayload,
  type LoadRequestPayload,
  type MainToRunnerMessage,
  type ResolveRequestPayload,
  type RunnerToMainMessage,
} from './protocol';
import { LruCache } from './lru';
import {
  prepareModuleOnDemand,
  type PreparedModule,
} from './prepareModuleOnDemand';
import {
  deserializeValue,
  encodeGlobals,
  serializeValue,
  type SerializedValue,
} from './serialize';

type HiddenModuleMembers = {
  _extensions: Record<string, () => void>;
  _resolveFilename: (
    id: string,
    options: { filename: string; id: string; paths: string[] }
  ) => string;
  _nodeModulePaths(filename: string): string[];
};

const DefaultModuleImplementation = NativeModule as typeof NativeModule &
  HiddenModuleMembers;

const NOOP = () => {};

const isBuiltinSpecifier = (specifier: string) => {
  const normalized = specifier.startsWith('node:')
    ? specifier.slice(5)
    : specifier;
  return (
    DefaultModuleImplementation.builtinModules?.includes(normalized) ||
    DefaultModuleImplementation.builtinModules?.includes(`node:${normalized}`)
  );
};

const isVirtualSpecifier = (specifier: string) =>
  specifier.startsWith('/@') ||
  specifier.startsWith('virtual:') ||
  specifier.startsWith('\0');

const isEvalOnlyKey = (key: string) =>
  key === '__wywPreval' || key === 'side-effect';

const isExportContainer = (
  value: unknown
): value is Record<string | symbol, unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

const hasCachedExport = (
  source: Record<string | symbol, unknown>,
  key: string
) => {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    return true;
  }
  if (key === 'default') {
    return false;
  }
  const fallback = source.default;
  return (
    isExportContainer(fallback) &&
    Object.prototype.hasOwnProperty.call(fallback, key)
  );
};

const resolveCachedExport = (
  source: Record<string | symbol, unknown>,
  key: string
) => {
  if (key === 'default') {
    return Object.prototype.hasOwnProperty.call(source, 'default')
      ? (source as Record<string, unknown>).default
      : undefined;
  }

  if (Object.prototype.hasOwnProperty.call(source, key)) {
    return (source as Record<string, unknown>)[key];
  }

  const fallback = (source as Record<string, unknown>).default;
  if (
    isExportContainer(fallback) &&
    Object.prototype.hasOwnProperty.call(fallback, key)
  ) {
    return (fallback as Record<string, unknown>)[key];
  }

  return undefined;
};

const serializeCachedExports = (
  exportsValue: Record<string | symbol, unknown>,
  requiredOnly: string[]
): Record<string, SerializedValue> | null => {
  if (requiredOnly.some(isEvalOnlyKey)) {
    return null;
  }

  const keys = requiredOnly.includes('*')
    ? Object.keys(exportsValue).filter((key) => !isEvalOnlyKey(key))
    : requiredOnly.filter((key) => !isEvalOnlyKey(key));

  if (keys.length === 0) {
    return null;
  }

  const serialized: Record<string, SerializedValue> = {};
  for (const key of keys) {
    if (!hasCachedExport(exportsValue, key)) {
      return null;
    }
    try {
      const encoded = serializeValue(resolveCachedExport(exportsValue, key));
      if (encoded.kind === 'function') {
        return null;
      }
      serialized[key] = encoded;
    } catch {
      return null;
    }
  }

  return serialized;
};

const DEFAULT_EVAL_OPTIONS: Required<
  Pick<EvalOptionsV2, 'mode' | 'require' | 'resolver'>
> = {
  mode: 'strict',
  require: 'warn-and-run',
  resolver: 'bundler',
};

const MAX_MESSAGE_SIZE = 10 * 1024 * 1024;
const RESOLVE_CACHE_SIZE = 5000;
const LOAD_CACHE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const EVAL_TIMEOUT_MS = Number(process.env.WYW_EVAL_TIMEOUT_MS ?? 300_000);
const INIT_TIMEOUT_MS = 120_000;
const HAPPYDOM_INIT_TIMEOUT_MS = Number(
  process.env.WYW_EVAL_HAPPYDOM_INIT_TIMEOUT_MS ?? 15_000
);

type ResolveCacheEntry = {
  resolvedId: string | null;
  external?: boolean;
  usedNodeFallback?: boolean;
};

type ResolveResult = ResolveCacheEntry & {
  only: string[];
};

type PreparedCacheEntry = PreparedModule & {
  hash: string;
  exports?: Record<string, SerializedValue>;
};

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const isEvalTimeoutError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && (error as { code?: string }).code) {
    return (error as { code?: string }).code === 'WYW_EVAL_TIMEOUT';
  }
  return false;
};

const warnedUnknownImportsByServices = new WeakMap<Services, Set<string>>();

const getWarnedUnknownImports = (services: Services): Set<string> => {
  const cached = warnedUnknownImportsByServices.get(services);
  if (cached) return cached;
  const created = new Set<string>();
  warnedUnknownImportsByServices.set(services, created);
  return created;
};

const getEvalOptions = (services: Services): EvalOptionsV2 => ({
  ...DEFAULT_EVAL_OPTIONS,
  ...(services.options.pluginOptions.eval ?? {}),
});

const buildRunnerPath = (): string => {
  const url = new URL('./runner.js', import.meta.url);
  return fileURLToPath(url);
};

const buildRunnerInitPayload = (
  services: Services,
  entrypoint: Entrypoint,
  featuresOverride?: FeatureFlags<'happyDOM'>
): EvalRunnerInitPayload => {
  const evalOptions = getEvalOptions(services);
  const { pluginOptions, root } = services.options;
  const { overrideContext, importOverrides, extensions } = pluginOptions;
  const features = featuresOverride ?? pluginOptions.features;
  const baseGlobals: Record<string, unknown> = {
    ...(evalOptions.globals ?? {}),
  };
  const withFilename = {
    ...baseGlobals,
    __filename: entrypoint.name,
    __dirname: path.dirname(entrypoint.name),
  };
  const globals = overrideContext
    ? overrideContext(withFilename, entrypoint.name)
    : withFilename;

  return {
    evalOptions: {
      globals: encodeGlobals(globals) as Record<string, unknown>,
      importOverrides,
      mode: evalOptions.mode ?? 'strict',
      require: evalOptions.require ?? 'warn-and-run',
      root,
      extensions,
    },
    features,
    entrypoint: entrypoint.name,
  };
};

const emitWarning = (services: Services, message: string) => {
  if (services.emitWarning) {
    services.emitWarning(message);
    return;
  }

  // eslint-disable-next-line no-console
  console.warn(message);
};

const emitEvalWarning = (services: Services, warning: EvalWarning) => {
  const { onWarn } = getEvalOptions(services);
  onWarn?.(warning);
  emitWarning(services, warning.message);
};

const defaultImportLoaders: ImportLoaders = {
  raw: 'raw',
  url: 'url',
};

const loadByImportLoaders = (
  services: Services,
  request: string,
  resolved: string,
  importer: string
): { handled: boolean; value: unknown } => {
  const { pluginOptions } = services.options;
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
    emitWarning: (message) => emitWarning(services, message),
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
};

const hashContent = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

const formatLoaderResult = (code: string, loader?: string | null) => {
  if (loader === 'json') {
    return `export default ${JSON.stringify(JSON.parse(code))};`;
  }
  if (loader === 'raw' || loader === 'text') {
    return `export default ${JSON.stringify(code)};`;
  }
  return code;
};

const toSerializedError = (error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    message: err.message,
    name: err.name,
    stack: err.stack,
  };
};

export class EvalBroker {
  private runner: ChildProcessWithoutNullStreams | null = null;

  private runnerReady: Promise<void> | null = null;

  private lastInitKey: string | null = null;

  private evalQueue: Promise<void> = Promise.resolve();

  private readonly pending = new Map<string, PendingRequest>();

  private nextId = 0;

  private readonly resolveCache = new LruCache<string, ResolveCacheEntry>(
    RESOLVE_CACHE_SIZE
  );

  private readonly resolveInFlight = new Map<
    string,
    Promise<ResolveCacheEntry>
  >();

  private readonly loadCache = new LruCache<string, PreparedCacheEntry>(
    LOAD_CACHE_SIZE
  );

  private readonly loadInFlight = new Map<
    string,
    Promise<PreparedCacheEntry>
  >();

  private readonly importsByModule = new Map<string, Map<string, string[]>>();

  private readonly onlyByModule = new Map<string, string[]>();

  private readonly dependencies = new Set<string>();

  private happyDomDisabled = false;

  private happyDomDisableWarned = false;

  constructor(
    private readonly services: Services,
    private readonly asyncResolve: (
      what: string,
      importer: string,
      stack: string[]
    ) => Promise<string | null>
  ) {}

  private ensureImportsMapping(
    id: string,
    imports: Map<string, string[]> | null | undefined
  ) {
    this.importsByModule.set(id, imports ?? new Map());
  }

  public async evaluate(entrypoint: Entrypoint): Promise<{
    values: Map<string, unknown> | null;
    dependencies: string[];
  }> {
    const task = this.evalQueue.then(async () => {
      this.dependencies.clear();
      this.importsByModule.clear();
      this.onlyByModule.clear();
      this.resolveCache.clear();
      this.resolveInFlight.clear();
      this.onlyByModule.set(entrypoint.name, ['__wywPreval']);

      await this.ensureRunner();
      await this.initRunner(entrypoint);

      const payload = await this.request<EvalResultPayload>(
        'EVAL',
        {
          id: entrypoint.name,
        },
        EVAL_TIMEOUT_MS
      );

      if (payload.modules) {
        this.applyModuleExports(payload.modules);
      }

      if (!payload.values) {
        return { values: null, dependencies: [] };
      }

      const values = new Map<string, unknown>();
      Object.entries(payload.values).forEach(([key, serialized]) => {
        values.set(key, deserializeValue(serialized));
      });

      return {
        values,
        dependencies: this.collectEntrypointDependencies(entrypoint.name),
      };
    });

    this.evalQueue = task.then(
      () => {},
      () => {}
    );

    return task;
  }

  private applyModuleExports(
    modules: Record<string, Record<string, SerializedValue>>
  ) {
    Object.entries(modules).forEach(([id, serializedExports]) => {
      if (!serializedExports || Object.keys(serializedExports).length === 0) {
        return;
      }

      const cached = this.services.cache.get('entrypoints', id);
      if (!cached || cached.ignored) {
        return;
      }

      const target =
        cached.evaluated || !('createEvaluated' in cached)
          ? cached
          : cached.createEvaluated();

      const exportsProxy = target.exports;
      Object.entries(serializedExports).forEach(([key, serialized]) => {
        exportsProxy[key] = deserializeValue(serialized);
      });

      const merged = mergeOnly(
        target.evaluatedOnly ?? [],
        Object.keys(serializedExports)
      );
      if (target.evaluatedOnly) {
        target.evaluatedOnly.splice(0, target.evaluatedOnly.length, ...merged);
      }

      this.services.cache.add('entrypoints', id, target);
    });
  }

  public dispose() {
    if (this.runner) {
      this.runner.removeAllListeners();
      this.runner.kill();
      this.runner = null;
      this.runnerReady = null;
    }
    this.lastInitKey = null;
  }

  private async ensureRunner() {
    if (this.runnerReady) {
      await this.runnerReady;
      return;
    }

    const runnerPath = buildRunnerPath();
    const nodeBinary =
      process.env.WYW_NODE_BINARY ||
      (process.execPath.includes('bun') ? 'node' : process.execPath);

    this.runner = spawn(nodeBinary, ['--experimental-vm-modules', runnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.services.options.root ?? process.cwd(),
      env: {
        ...process.env,
        WYW_EVAL_RUNNER: '1',
        NODE_NO_WARNINGS: '1',
      },
    });

    this.runner.stdout.setEncoding('utf8');
    this.runner.stderr.setEncoding('utf8');

    this.runner.stdout.on('data', (chunk) => this.onData(chunk));
    this.runner.stderr.on('data', (chunk) => {
      emitWarning(this.services, `[wyw-eval-runner] ${chunk.toString()}`);
    });
    this.runner.on('exit', (code, signal) => {
      const reason = `Eval runner exited (${code ?? 'null'} / ${
        signal ?? 'null'
      })`;
      this.rejectAllPending(new Error(reason));
      this.runner = null;
      this.runnerReady = null;
      this.lastInitKey = null;
    });

    this.runnerReady = Promise.resolve();
    await this.runnerReady;
  }

  private async initRunner(entrypoint: Entrypoint) {
    const initKey = entrypoint.name;
    if (this.lastInitKey === initKey) {
      return;
    }

    const features = this.getRunnerFeatures();
    const payload = buildRunnerInitPayload(this.services, entrypoint, features);
    const timeoutMs = this.getInitTimeoutMs(entrypoint, features);

    try {
      await this.request('INIT', payload, timeoutMs);
      this.lastInitKey = initKey;
    } catch (error) {
      if (
        isEvalTimeoutError(error) &&
        !this.happyDomDisabled &&
        isFeatureEnabled(features, 'happyDOM', entrypoint.name)
      ) {
        this.happyDomDisabled = true;
        this.warnHappyDomDisabledOnce(timeoutMs);
        this.dispose();
        await this.ensureRunner();
        const fallbackFeatures = this.getRunnerFeatures();
        const fallbackPayload = buildRunnerInitPayload(
          this.services,
          entrypoint,
          fallbackFeatures
        );
        await this.request('INIT', fallbackPayload, INIT_TIMEOUT_MS);
        this.lastInitKey = initKey;
        return;
      }
      throw error;
    }
  }

  private getRunnerFeatures(): FeatureFlags<'happyDOM'> {
    const base = this.services.options.pluginOptions.features;
    if (!this.happyDomDisabled) return base;
    return { ...base, happyDOM: false };
  }

  private getInitTimeoutMs(
    entrypoint: Entrypoint,
    features: FeatureFlags<'happyDOM'>
  ) {
    if (
      this.happyDomDisabled ||
      !HAPPYDOM_INIT_TIMEOUT_MS ||
      HAPPYDOM_INIT_TIMEOUT_MS <= 0
    ) {
      return INIT_TIMEOUT_MS;
    }

    if (isFeatureEnabled(features, 'happyDOM', entrypoint.name)) {
      return Math.min(INIT_TIMEOUT_MS, HAPPYDOM_INIT_TIMEOUT_MS);
    }

    return INIT_TIMEOUT_MS;
  }

  private warnHappyDomDisabledOnce(timeoutMs: number) {
    if (this.happyDomDisableWarned) return;
    this.happyDomDisableWarned = true;
    emitWarning(
      this.services,
      [
        `[wyw-in-js] DOM emulation initialization exceeded ${timeoutMs}ms and will be disabled for this run.`,
        `WyW will continue without DOM emulation (as if features.happyDOM:false).`,
        ``,
        `To silence this warning: set features: { happyDOM: false }.`,
        `To restore DOM emulation, ensure "happy-dom" can be imported in the build-time runtime.`,
        `You can tune the timeout with WYW_EVAL_HAPPYDOM_INIT_TIMEOUT_MS.`,
      ].join('\n')
    );
  }

  private onData(chunk: string) {
    const buffer = (this.onData as { buffer?: string }).buffer ?? '';
    const next = `${buffer}${chunk}`;
    const lines = next.split('\n');
    (this.onData as { buffer?: string }).buffer = lines.pop() ?? '';
    lines.forEach((line) => {
      if (!line.trim()) return;
      let message: RunnerToMainMessage;
      try {
        message = JSON.parse(line);
      } catch (error) {
        emitWarning(
          this.services,
          `[wyw-eval-runner] Failed to parse message: ${line}`
        );
        return;
      }

      this.handleMessage(message);
    });
  }

  private handleMessage(message: RunnerToMainMessage) {
    switch (message.type) {
      case 'INIT_ACK':
        if (message.error) {
          this.rejectPending(message.id, message.error);
          this.runner?.kill();
          return;
        }
        this.resolvePending(message.id, {});
        return;
      case 'EVAL_RESULT':
        if (message.error) {
          this.rejectPending(message.id, message.error);
          return;
        }
        this.resolvePending(message.id, message.payload);
        return;
      case 'RESOLVE':
        this.handleResolve(message.id, message.payload).catch((error) => {
          this.sendMessage({
            type: 'RESOLVE_RESULT',
            id: message.id,
            payload: {
              resolvedId: null,
              error: toSerializedError(error),
            },
          });
        });
        return;
      case 'LOAD':
        this.handleLoad(message.id, message.payload).catch((error) => {
          this.sendMessage({
            type: 'LOAD_RESULT',
            id: message.id,
            payload: {
              id: message.payload.id,
              error: toSerializedError(error),
            },
          });
        });
        return;
      case 'WARN':
        this.handleWarn(message.payload);
        break;
      default:
        break;
    }
  }

  private handleWarn(warning: EvalWarning) {
    if (warning.code === 'require-fallback' && warning.specifier) {
      this.dependencies.add(warning.specifier);
    }
    emitEvalWarning(this.services, warning);
  }

  private async handleResolve(id: string, payload: ResolveRequestPayload) {
    const result = await this.resolveImport(payload);
    this.sendMessage({
      type: 'RESOLVE_RESULT',
      id,
      payload: {
        resolvedId: result.resolvedId,
        external: result.external,
      },
    });
  }

  private normalizeResolvedId(
    resolvedId: string,
    specifier: string,
    importerId?: string
  ): string {
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
      if (!importerId) {
        return resolvedId;
      }
      const importerFile = stripQueryAndHash(importerId);
      candidate = path.resolve(path.dirname(importerFile), candidate);
    }

    const suffix = resolvedId.slice(stripped.length);
    for (const ext of this.services.options.pluginOptions.extensions) {
      const fileCandidate = `${candidate}${ext}`;
      if (fs.existsSync(fileCandidate)) {
        return `${fileCandidate}${suffix}`;
      }

      const indexCandidate = path.join(candidate, `index${ext}`);
      if (fs.existsSync(indexCandidate)) {
        return `${indexCandidate}${suffix}`;
      }
    }

    if (importerId) {
      try {
        const importerFile = stripQueryAndHash(importerId);
        const resolved = DefaultModuleImplementation._resolveFilename(stripped, {
          id: importerFile,
          filename: importerFile,
          paths: DefaultModuleImplementation._nodeModulePaths(
            path.dirname(importerFile)
          ),
        });
        if (resolved && resolved !== stripped) {
          return `${resolved}${suffix}`;
        }
      } catch {
        // ignore fallback failures
      }
    }

    return resolvedId;
  }

  private async resolveImport({
    specifier,
    importerId,
    kind,
  }: ResolveRequestPayload): Promise<ResolveResult> {
    if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
      // eslint-disable-next-line no-console
      console.warn('[wyw-eval:resolve]', { specifier, importerId, kind });
    }
    const key = `${kind}:${importerId}:${specifier}`;
    const evalOptions = getEvalOptions(this.services);
    const stack = [importerId];
    const importsOnly = this.importsByModule.get(importerId)?.get(specifier);
    const only = importsOnly ?? ['*'];
    if (process.env.WYW_DEBUG_EVAL_RESOLVE && !importsOnly) {
      // eslint-disable-next-line no-console
      console.warn('[wyw-eval:resolve:only-miss]', {
        specifier,
        importerId,
        kind,
      });
    }
    const strippedSpecifier = stripQueryAndHash(specifier);
    if (path.isAbsolute(strippedSpecifier)) {
      const normalized = this.normalizeResolvedId(
        specifier,
        specifier,
        importerId
      );
      const overridden = this.applyImportOverrides(
        {
          source: specifier,
          resolved: normalized,
          only,
          external: false,
        },
        importerId,
        stack
      );
      this.resolveCache.set(key, { resolvedId: normalized, external: false });
      return overridden;
    }

    const cached = this.resolveCache.get(key);
    if (cached) {
      if (!cached.resolvedId) {
        return { resolvedId: null, only: ['*'] };
      }

      const normalized = this.normalizeResolvedId(
        cached.resolvedId,
        specifier,
        importerId
      );
      const overridden = this.applyImportOverrides(
        {
          source: specifier,
          resolved: normalized,
          only,
          external: cached.external,
        },
        importerId,
        stack
      );
      if (cached.usedNodeFallback) {
        this.maybeWarnNodeFallback({
          importerId,
          specifier,
          resolvedId: normalized,
          kind,
        });
      }
      return overridden;
    }

    const inFlight = this.resolveInFlight.get(key);
    if (inFlight) {
      const cachedResult = await inFlight;
      if (!cachedResult.resolvedId) {
        return { resolvedId: null, only: ['*'] };
      }
      const normalized = this.normalizeResolvedId(
        cachedResult.resolvedId,
        specifier,
        importerId
      );
      const overridden = this.applyImportOverrides(
        {
          source: specifier,
          resolved: normalized,
          only,
          external: cachedResult.external,
        },
        importerId,
        stack
      );
      if (cachedResult.usedNodeFallback) {
        this.maybeWarnNodeFallback({
          importerId,
          specifier,
          resolvedId: normalized,
          kind,
        });
      }
      return overridden;
    }

    const task: Promise<ResolveCacheEntry> = (async () => {
      if (evalOptions.customResolver) {
        const customResolved = await evalOptions.customResolver(
          specifier,
          importerId,
          kind
        );
        if (customResolved) {
          const normalized = this.normalizeResolvedId(
            customResolved.id,
            specifier,
            importerId
          );
          if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
            // eslint-disable-next-line no-console
            console.warn('[wyw-eval:resolve:custom]', {
              specifier,
              importerId,
              resolved: customResolved.id,
              normalized,
              external: customResolved.external,
            });
          }
          return {
            resolvedId: normalized,
            external: customResolved.external,
          };
        }

        if (evalOptions.resolver === 'custom') {
          return { resolvedId: null };
        }
      }

      if (evalOptions.resolver !== 'node') {
        let resolved: string | null = null;
        try {
          resolved = await this.asyncResolve(specifier, importerId, stack);
        } catch {
          resolved = null;
        }
        if (resolved) {
          const normalized = this.normalizeResolvedId(
            resolved,
            specifier,
            importerId
          );
          if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
            // eslint-disable-next-line no-console
            console.warn('[wyw-eval:resolve:async]', {
              specifier,
              importerId,
              resolved,
              normalized,
            });
          }
          return {
            resolvedId: normalized,
          };
        }
      }

      if (evalOptions.resolver === 'node' || evalOptions.require !== 'off') {
        const nodeResolved = this.resolveWithNodeFallback(
          specifier,
          importerId
        );
        if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
          // eslint-disable-next-line no-console
          console.warn('[wyw-eval:resolve:node]', {
            specifier,
            importerId,
            resolved: nodeResolved.resolvedId,
          });
        }
        return {
          ...nodeResolved,
          usedNodeFallback: evalOptions.resolver !== 'node',
        };
      }

      if (process.env.WYW_DEBUG_EVAL_RESOLVE) {
        // eslint-disable-next-line no-console
        console.warn('[wyw-eval:resolve:none]', {
          specifier,
          importerId,
        });
      }
      return { resolvedId: null };
    })();

    this.resolveInFlight.set(key, task);

    try {
      const result = await task;
      this.resolveCache.set(key, result);

      if (!result.resolvedId) {
        return { resolvedId: null, only: ['*'] };
      }

      const overridden = this.applyImportOverrides(
        {
          source: specifier,
          resolved: result.resolvedId,
          only,
          external: result.external,
        },
        importerId,
        stack
      );

      if (result.usedNodeFallback && result.resolvedId) {
        this.maybeWarnNodeFallback({
          importerId,
          specifier,
          resolvedId: result.resolvedId,
          kind,
        });
      }

      return overridden;
    } finally {
      this.resolveInFlight.delete(key);
    }
  }

  private collectEntrypointDependencies(entrypointId: string): string[] {
    const collected = new Set(this.dependencies);
    const imports = this.importsByModule.get(entrypointId);
    if (imports) {
      for (const specifier of imports.keys()) {
        if (isBuiltinSpecifier(specifier) || isVirtualSpecifier(specifier)) {
          continue;
        }
        collected.add(specifier);
      }
    }
    return Array.from(collected);
  }

  private applyImportOverrides(
    resolved: {
      source: string;
      resolved: string;
      only: string[];
      external?: boolean;
    },
    importerId: string,
    stack: string[]
  ): ResolveResult {
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

    let nextResolved = resolved.resolved;
    let nextExternal = resolved.external;
    if (override?.mock) {
      nextResolved = resolveMockSpecifier({
        mock: override.mock,
        importer: importerId,
        root,
        stack,
      });
      nextExternal = false;
    }

    const nextOnly = applyImportOverrideToOnly(resolved.only, override);
    const storedOnly = this.onlyByModule.get(nextResolved);
    this.onlyByModule.set(
      nextResolved,
      storedOnly ? mergeOnly(storedOnly, nextOnly) : nextOnly
    );
    return {
      resolvedId: nextResolved,
      external: nextExternal,
      only: nextOnly,
    };
  }

  private resolveWithNodeFallback(
    specifier: string,
    importerId: string
  ): ResolveCacheEntry {
    const extensions = DefaultModuleImplementation._extensions;
    const added: string[] = [];

    try {
      this.services.options.pluginOptions.extensions.forEach((ext) => {
        if (ext in extensions) return;
        extensions[ext] = NOOP;
        added.push(ext);
      });

      const filename = importerId;
      const strippedId = stripQueryAndHash(specifier);

      let resolved: string;
      try {
        resolved = DefaultModuleImplementation._resolveFilename(strippedId, {
          id: filename,
          filename,
          paths: DefaultModuleImplementation._nodeModulePaths(
            path.dirname(filename)
          ),
        });
      } catch (error) {
        throw new Error(
          [
            `[wyw-in-js] Node resolver failed during eval.`,
            ``,
            `importer: ${filename}`,
            `source:   ${specifier}`,
            ``,
            `error: ${error instanceof Error ? error.message : String(error)}`,
          ].join('\n')
        );
      }

      const isFileSpecifier =
        strippedId.startsWith('.') || path.isAbsolute(strippedId);

      if (
        isFileSpecifier &&
        path.extname(strippedId) === '' &&
        resolved.endsWith('.cjs') &&
        fs.existsSync(`${resolved.slice(0, -4)}.js`)
      ) {
        resolved = `${resolved.slice(0, -4)}.js`;
      }

      return {
        resolvedId: this.normalizeResolvedId(resolved, specifier, importerId),
      };
    } finally {
      added.forEach((ext) => delete extensions[ext]);
    }
  }

  private maybeWarnNodeFallback({
    importerId,
    specifier,
    resolvedId,
    kind,
  }: {
    importerId: string;
    specifier: string;
    resolvedId: string;
    kind: ResolveRequestPayload['kind'];
  }) {
    const evalOptions = getEvalOptions(this.services);
    const { root } = this.services.options;
    const keyInfo = toImportKey({
      source: specifier,
      resolved: resolvedId,
      root,
    });

    const override = getImportOverride(
      this.services.options.pluginOptions.importOverrides,
      keyInfo.key
    );

    if (override && override.unknown === undefined) {
      return;
    }

    const basePolicy: 'warn' | 'error' =
      evalOptions.require === 'warn-and-run' ? 'warn' : 'error';
    let policy = override?.unknown ?? basePolicy;
    if (evalOptions.require === 'off' && policy !== 'error') {
      policy = 'error';
    }

    if (policy === 'error') {
      throw new Error(
        [
          `[wyw-in-js] Unknown import reached during eval (Node resolver fallback)`,
          ``,
          `importer: ${importerId}`,
          `source:   ${specifier}`,
          `resolved: ${resolvedId}`,
          ``,
          `config key: ${keyInfo.key}`,
          `docs: https://wyw-in-js.dev/troubleshooting`,
        ]
          .filter(Boolean)
          .join('\n')
      );
    }

    const warnedUnknownImports = getWarnedUnknownImports(this.services);
    if (policy === 'warn' && !warnedUnknownImports.has(keyInfo.key)) {
      warnedUnknownImports.add(keyInfo.key);
      const warningMessage = [
        `[wyw-in-js] Unknown import reached during eval (Node resolver fallback)`,
        ``,
        `importer: ${importerId}`,
        `source:   ${specifier}`,
        `resolved: ${resolvedId}`,
        ``,
        `config key: ${keyInfo.key}`,
        `hint: add { importOverrides: { ${JSON.stringify(
          keyInfo.key
        )}: { unknown: 'allow' } } } to silence warnings, or use { mock } / { noShake: true } overrides.`,
        `docs: https://wyw-in-js.dev/troubleshooting`,
      ]
        .filter(Boolean)
        .join('\n');

      emitEvalWarning(this.services, {
        code: kind === 'require' ? 'require-fallback' : 'resolve-fallback',
        message: warningMessage,
        importer: importerId,
        specifier,
        resolved: resolvedId ?? null,
        callstack: [importerId],
        hint: `Use importOverrides or eval.require settings to avoid fallback.`,
      });
    }
  }

  private async handleLoad(id: string, payload: LoadRequestPayload) {
    const prepared = await this.loadModule(payload);
    this.sendMessage({
      type: 'LOAD_RESULT',
      id,
      payload: {
        id: payload.id,
        code: prepared.code,
        map: null,
        hash: prepared.hash,
        only: prepared.only,
        exports: prepared.exports,
      },
    });
  }

  private async loadModule({
    id,
    importerId,
    request,
  }: LoadRequestPayload): Promise<PreparedCacheEntry> {
    const cached = this.loadCache.get(id);
    const requiredOnly = this.onlyByModule.get(id) ?? ['*'];
    const cachedEntrypoint = this.services.cache.get('entrypoints', id) as
      | {
          evaluated?: boolean;
          evaluatedOnly?: string[];
          exports?: Record<string | symbol, unknown>;
          ignored?: boolean;
        }
      | undefined;
    if (
      cachedEntrypoint &&
      cachedEntrypoint.evaluated &&
      !cachedEntrypoint.ignored &&
      cachedEntrypoint.exports &&
      isSuperSet(cachedEntrypoint.evaluatedOnly ?? [], requiredOnly)
    ) {
      const cacheOnly = cachedEntrypoint.evaluatedOnly ?? requiredOnly;
      const serialized = serializeCachedExports(
        cachedEntrypoint.exports,
        cacheOnly
      );
      if (serialized) {
        const hash = hashContent(`exports:${JSON.stringify(serialized)}`);
        return {
          code: '',
          imports: null,
          only: cacheOnly,
          hash,
          exports: serialized,
        };
      }
    }
    if (cached && isSuperSet(cached.only, requiredOnly)) {
      this.ensureImportsMapping(id, cached.imports);
      return cached;
    }

    const inflight = this.loadInFlight.get(id);
    if (inflight) {
      const result = await inflight;
      if (isSuperSet(result.only, requiredOnly)) {
        this.ensureImportsMapping(id, result.imports);
        return result;
      }
    }

    const task = (async () => {
      const evalOptions = getEvalOptions(this.services);

      if (evalOptions.customLoader) {
        const loaded = await evalOptions.customLoader(id);
        if (loaded) {
          const code = formatLoaderResult(loaded.code, loaded.loader);
          return {
            code,
            imports: null,
            only: requiredOnly,
            hash: hashContent(code),
          };
        }
      }

      if (request && importerId) {
        const loaded = loadByImportLoaders(
          this.services,
          request,
          id,
          importerId
        );
        if (loaded.handled) {
          const code = `export default ${JSON.stringify(loaded.value)};`;
          return {
            code,
            imports: null,
            only: requiredOnly,
            hash: hashContent(code),
          };
        }
      }

      const stripped = stripQueryAndHash(id);
      const extension = path.extname(stripped);
      if (extension === '.json') {
        const jsonSource = fs.readFileSync(stripped, 'utf-8');
        const code = `export default ${JSON.stringify(
          JSON.parse(jsonSource)
        )};`;
        return {
          code,
          imports: null,
          only: requiredOnly,
          hash: hashContent(code),
        };
      }

      if (
        extension &&
        !this.services.options.pluginOptions.extensions.includes(extension)
      ) {
        const code = `export default ${JSON.stringify(id)};`;
        return {
          code,
          imports: null,
          only: requiredOnly,
          hash: hashContent(code),
        };
      }

      const prepared = prepareModuleOnDemand(
        this.services,
        id,
        cached ? mergeOnly(cached.only, requiredOnly) : requiredOnly
      );

      this.ensureImportsMapping(id, prepared.imports);

      const hash = hashContent(prepared.code);
      return { ...prepared, hash };
    })();

    this.loadInFlight.set(id, task);

    try {
      const result = await task;
      this.loadCache.set(id, result);
      return result;
    } finally {
      this.loadInFlight.delete(id);
    }
  }

  private sendMessage(message: MainToRunnerMessage) {
    const payload = `${JSON.stringify(message)}\n`;
    invariant(payload.length < MAX_MESSAGE_SIZE, 'Message too large');

    this.runner?.stdin.write(payload);
  }

  private request<TPayload>(
    type: MainToRunnerMessage['type'],
    payload: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<TPayload> {
    this.nextId += 1;
    const id = `${this.nextId}`;
    const message: MainToRunnerMessage = {
      type: type as MainToRunnerMessage['type'],
      id,
      payload: payload as never,
    } as MainToRunnerMessage;

    return new Promise<TPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.runner?.kill();
        const error = new Error(
          `[wyw-in-js] Eval runner timed out for ${type}`
        );
        (error as { code?: string }).code = 'WYW_EVAL_TIMEOUT';
        reject(error);
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as PendingRequest['resolve'],
        reject,
        timeout,
      });

      this.sendMessage(message);
    });
  }

  private resolvePending(id: string, payload: unknown) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    pending.resolve(payload);
  }

  private rejectPending(
    id: string,
    error: { message: string; stack?: string }
  ) {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    const err = new Error(error.message);
    if (error.stack) {
      err.stack = error.stack;
    }
    pending.reject(err);
  }

  private rejectAllPending(error: Error) {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
    this.pending.clear();
  }
}

const evalBrokers = new WeakMap<
  Services['cache'],
  { key: string; broker: EvalBroker }
>();

export const disposeEvalBroker = (cache: Services['cache']) => {
  const cached = evalBrokers.get(cache);
  if (!cached) return;
  cached.broker.dispose();
  evalBrokers.delete(cache);
};

export const getEvalBroker = (
  services: Services,
  asyncResolve: (
    what: string,
    importer: string,
    stack: string[]
  ) => Promise<string | null>,
  cacheKey: string
) => {
  const cached = evalBrokers.get(services.cache);
  if (cached && cached.key === cacheKey) return cached.broker;

  if (cached) {
    disposeEvalBroker(services.cache);
  }
  const broker = new EvalBroker(services, asyncResolve);
  evalBrokers.set(services.cache, { key: cacheKey, broker });
  return broker;
};
