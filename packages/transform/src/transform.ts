/**
 * This file exposes sync and async transform functions that:
 * - parse the passed code to AST
 * - builds a dependency graph for the file
 * - shakes each dependency and removes unused code
 * - runs generated code in a sandbox
 * - collects artifacts
 * - returns transformed code (without WYW template literals), generated CSS, source maps and babel metadata from transform step.
 */

import { createHash } from 'crypto';

import { isFeatureEnabled } from '@wyw-in-js/shared';

import type { PartialOptions } from './transform/helpers/loadWywOptions';
import { loadWywOptions } from './transform/helpers/loadWywOptions';
import { TransformCacheCollection } from './cache';
import { Entrypoint } from './transform/Entrypoint';
import { asyncActionRunner } from './transform/actions/actionRunner';
import { baseHandlers } from './transform/generators';
import { asyncResolveImports } from './transform/generators/resolveImports';
import { withDefaultServices } from './transform/helpers/withDefaultServices';
import type {
  Handler,
  Handlers,
  IResolveImportsAction,
  Services,
} from './transform/types';
import type { Result } from './types';
import { getEvalBroker } from './eval/broker';

type PartialServices = Partial<Omit<Services, 'options'>> & {
  options: Omit<Services['options'], 'pluginOptions'> & {
    pluginOptions?: PartialOptions;
  };
};

type AllHandlers<TMode extends 'async' | 'sync'> = Handlers<TMode>;

const memoizedAsyncResolve = new WeakMap<
  (what: string, importer: string, stack: string[]) => Promise<string | null>,
  Handler<'async' | 'sync', IResolveImportsAction>
>();

type ResolverFn = (...args: unknown[]) => unknown;

const resolverIds = new WeakMap<ResolverFn, number>();
let resolverId = 0;

const getResolverId = (fn: unknown) => {
  if (typeof fn !== 'function') return null;
  const resolver = fn as ResolverFn;
  const cached = resolverIds.get(resolver);
  if (cached) return cached;
  resolverId += 1;
  resolverIds.set(resolver, resolverId);
  return resolverId;
};

const getEvalCacheKey = (
  pluginOptions: ReturnType<typeof loadWywOptions>,
  asyncResolve: (
    what: string,
    importer: string,
    stack: string[]
  ) => Promise<string | null>
) => {
  const evalOptions = pluginOptions.eval ?? {};
  const payload = JSON.stringify({
    mode: evalOptions.mode,
    resolver: evalOptions.resolver,
    require: evalOptions.require,
    globals: evalOptions.globals ? Object.keys(evalOptions.globals).sort() : [],
    customResolver: getResolverId(evalOptions.customResolver),
    customLoader: getResolverId(evalOptions.customLoader),
    bundlerResolver: getResolverId(asyncResolve),
    overrideContext: getResolverId(pluginOptions.overrideContext),
    importOverrides: pluginOptions.importOverrides ?? null,
    extensions: pluginOptions.extensions,
    features: pluginOptions.features,
  });

  return createHash('sha256').update(payload).digest('hex');
};

export function transformSync(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _partialServices: PartialServices,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _originalCode: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _syncResolve: (what: string, importer: string, stack: string[]) => string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _customHandlers: Partial<AllHandlers<'sync'>> = {}
): Result {
  throw new Error(
    '[wyw-in-js] transformSync is not supported in v2. Use transform() (async) instead.'
  );
}

export async function transform(
  partialServices: PartialServices,
  originalCode: string,
  asyncResolve: (
    what: string,
    importer: string,
    stack: string[]
  ) => Promise<string | null>,
  customHandlers: Partial<AllHandlers<'sync'>> = {}
): Promise<Result> {
  const { options } = partialServices;
  const pluginOptions = loadWywOptions(options.pluginOptions);
  const services = withDefaultServices({
    ...partialServices,
    options: {
      ...options,
      pluginOptions,
    },
  });

  if (
    !isFeatureEnabled(pluginOptions.features, 'globalCache', options.filename)
  ) {
    // If global cache is disabled, we need to create a new cache for each file
    services.cache = new TransformCacheCollection();
  }

  const evalCacheKey = getEvalCacheKey(pluginOptions, asyncResolve);
  services.cache.setKeySalt(evalCacheKey);
  services.asyncResolve = asyncResolve;
  services.evalBroker = getEvalBroker(services, asyncResolve, evalCacheKey);

  /*
   * This method can be run simultaneously for multiple files.
   * A shared cache is accessible for all runs, but each run has its own queue
   * to maintain the correct processing order. The cache stores the outcome
   * of tree-shaking, and if the result is already stored in the cache
   * but the "only" option has changed, the file will be re-processed using
   * the combined "only" option.
   */
  const entrypoint = Entrypoint.createRoot(
    services,
    options.filename,
    ['__wywPreval'],
    originalCode
  );

  if (entrypoint.ignored) {
    return {
      code: originalCode,
      sourceMap: options.inputSourceMap,
    };
  }

  const workflowAction = entrypoint.createAction('workflow', undefined);

  if (!memoizedAsyncResolve.has(asyncResolve)) {
    const resolveImports = function resolveImports(
      this: IResolveImportsAction
    ) {
      return asyncResolveImports.call(this, asyncResolve);
    };

    memoizedAsyncResolve.set(asyncResolve, resolveImports);
  }

  try {
    const result = await asyncActionRunner(workflowAction, {
      ...baseHandlers,
      ...customHandlers,
      resolveImports: memoizedAsyncResolve.get(asyncResolve)!,
    });

    entrypoint.log('%s is ready', entrypoint.name);

    return result;
  } catch (err) {
    entrypoint.log('Unhandled error %O', err);

    if (
      isFeatureEnabled(pluginOptions.features, 'softErrors', options.filename)
    ) {
      // eslint-disable-next-line no-console
      console.error(`Error during transform of ${entrypoint.name}:`, err);

      return {
        code: originalCode,
        sourceMap: options.inputSourceMap,
      };
    }

    throw err;
  }
}
