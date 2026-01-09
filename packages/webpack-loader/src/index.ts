/**
 * This file contains a Webpack loader for WYW-in-JS.
 * It uses the transform.ts function to generate class names from source code,
 * returns transformed code without template literals and attaches generated source maps
 */

import path from 'path';
import crypto from 'crypto';

import type { RawSourceMap } from 'source-map';
import type { RawLoaderDefinitionFunction } from 'webpack';

import { logger } from '@wyw-in-js/shared';
import type { PluginOptions, Preprocessor, Result } from '@wyw-in-js/transform';
import { transform, TransformCacheCollection } from '@wyw-in-js/transform';

import { sharedState } from './WYWinJSDebugPlugin';
import type { ICache } from './cache';
import { getCacheInstance, registerCacheProvider } from './cache';

export { WYWinJSDebugPlugin } from './WYWinJSDebugPlugin';

const outputCssLoader = require.resolve('./outputCssLoader');

const stripQueryAndHash = (request: string) => {
  const queryIdx = request.indexOf('?');
  const hashIdx = request.indexOf('#');

  if (queryIdx === -1) {
    return hashIdx === -1 ? request : request.slice(0, hashIdx);
  }
  if (hashIdx === -1) return request.slice(0, queryIdx);

  return request.slice(0, Math.min(queryIdx, hashIdx));
};

const hashText = (text: string): string =>
  crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

export type LoaderOptions = {
  cacheProvider?: string | ICache;
  cssImport?: 'require' | 'import';
  extension?: string;
  keepComments?: boolean | RegExp;
  prefixer?: boolean;
  preprocessor?: Preprocessor;
  sourceMap?: boolean;
} & Partial<PluginOptions>;
type Loader = RawLoaderDefinitionFunction<LoaderOptions>;

const cache = new TransformCacheCollection();

type Resolver = (
  what: string,
  importer: string,
  stack: string[]
) => Promise<string>;

const resolvers: Record<string, Resolver[]> = {};

const getResolverKey = (importer: string, stack: string[]): string => {
  const root = stack.length ? stack[stack.length - 1] : importer;
  return stripQueryAndHash(root);
};

const asyncResolve = (
  what: string,
  importer: string,
  stack: string[] = [importer]
): Promise<string> => {
  const resolver = resolvers[getResolverKey(importer, stack)];
  if (!resolver || resolver.length === 0) {
    throw new Error('No resolver found');
  }

  // Every resolver should return the same result, but we need to call all of them
  // to ensure that all side effects are executed (e.g. adding dependencies)
  return Promise.all(resolver.map((r) => r(what, importer, stack))).then(
    (results) => {
      const firstResult = results[0];
      if (results.some((r) => r !== firstResult)) {
        throw new Error('Resolvers returned different results');
      }

      return firstResult;
    }
  );
};

function addResolver(resourcePath: string, resolver: Resolver) {
  if (!resolvers[resourcePath]) {
    resolvers[resourcePath] = [];
  }

  resolvers[resourcePath].push(resolver);

  return () => {
    resolvers[resourcePath] = resolvers[resourcePath].filter(
      (r) => r !== resolver
    );
  };
}

const webpack5Loader: Loader = function webpack5LoaderPlugin(
  content,
  inputSourceMap
) {
  function convertSourceMap(
    value: typeof inputSourceMap,
    filename: string
  ): RawSourceMap | undefined {
    if (typeof value === 'string' || !value) {
      return undefined;
    }

    return {
      ...value,
      file: value.file ?? filename,
      mappings: value.mappings ?? '',
      names: value.names ?? [],
      sources: value.sources ?? [],
      version: value.version ?? 3,
    };
  }

  // tell Webpack this loader is async
  this.async();

  const resolveOptions = { dependencyType: 'esm' };

  const resolveModule: (
    context: string,
    request: string,
    callback: (err: unknown, result: unknown) => void
  ) => unknown = this.getResolve(resolveOptions);

  const isPromiseLike = (value: unknown): value is Promise<unknown> =>
    typeof (value as { then?: unknown } | null)?.then === 'function';

  const resolveModuleAsync = (context: string, request: string) =>
    new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (err: unknown, result: unknown) => {
        if (settled) return;
        settled = true;

        if (err) {
          reject(err);
          return;
        }

        if (typeof result === 'string') {
          resolve(result);
          return;
        }

        reject(new Error(`Cannot resolve ${request}`));
      };

      try {
        const maybePromise = resolveModule(context, request, finish);
        if (isPromiseLike(maybePromise)) {
          maybePromise.then(
            (result) => finish(null, result),
            (err) => finish(err, null)
          );
        }
      } catch (err) {
        finish(err, null);
      }
    });

  const removeResolver = addResolver(this.resourcePath, (what, importer) => {
    const importerPath = stripQueryAndHash(importer);
    const context = path.isAbsolute(importerPath)
      ? path.dirname(importerPath)
      : path.join(process.cwd(), path.dirname(importerPath));

    return resolveModuleAsync(context, what).then((result) => {
      const filePath = stripQueryAndHash(result);
      if (path.isAbsolute(filePath)) {
        this.addDependency(filePath);
      }

      return result;
    });
  });

  logger('loader %s', this.resourcePath);

  const {
    sourceMap = undefined,
    preprocessor = undefined,
    keepComments = undefined,
    prefixer = undefined,
    extension = '.wyw-in-js.css',
    cssImport = 'require',
    cacheProvider,
    ...rest
  } = this.getOptions() || {};

  const outputFileName = this.resourcePath.replace(/\.[^.]+$/, extension);

  const transformServices = {
    options: {
      filename: this.resourcePath,
      inputSourceMap: convertSourceMap(inputSourceMap, this.resourcePath),
      pluginOptions: rest,
      prefixer,
      keepComments,
      preprocessor,
      root: process.cwd(),
    },
    cache,
    emitWarning: (message: string) => this.emitWarning(new Error(message)),
    eventEmitter: sharedState.emitter,
  };

  transform(transformServices, content.toString(), asyncResolve)
    .then(
      async (result: Result) => {
        try {
          if (result.cssText) {
            let { cssText } = result;

            if (sourceMap) {
              cssText += `/*# sourceMappingURL=data:application/json;base64,${Buffer.from(
                result.cssSourceMapText || ''
              ).toString('base64')}*/`;
            }

            await Promise.all(
              result.dependencies?.map((dep) =>
                asyncResolve(dep, this.resourcePath)
              ) ?? []
            );

            const cacheInstance = await getCacheInstance(cacheProvider);
            const cacheProviderId =
              cacheProvider && typeof cacheProvider === 'object'
                ? registerCacheProvider(cacheInstance)
                : '';

            await cacheInstance.set(this.resourcePath, cssText);

            await cacheInstance.setDependencies?.(
              this.resourcePath,
              this.getDependencies()
            );

            const wywQuery = [
              `wyw=${encodeURIComponent(extension.replace(/^\./, ''))}`,
            ];

            if (this.hot) {
              wywQuery.push(`v=${encodeURIComponent(hashText(cssText))}`);
            }

            const resourcePathWithQuery = `${this.resourcePath}?${wywQuery.join(
              '&'
            )}`;

            const request = `${outputFileName}!=!${outputCssLoader}?cacheProvider=${encodeURIComponent(
              typeof cacheProvider === 'string' ? cacheProvider : ''
            )}&cacheProviderId=${encodeURIComponent(
              cacheProviderId
            )}!${resourcePathWithQuery}`;
            const stringifiedRequest = JSON.stringify(
              this.utils.contextify(this.context || this.rootContext, request)
            );

            const importCss =
              cssImport === 'import'
                ? `import ${stringifiedRequest};`
                : `require(${stringifiedRequest});`;

            this.callback(
              null,
              `${result.code}\n\n${importCss}`,
              result.sourceMap ?? undefined
            );

            return;
          }

          this.callback(null, result.code, result.sourceMap ?? undefined);
        } catch (err) {
          this.callback(err as Error);
        }
      },
      (err: Error) => {
        this.callback(err);
      }
    )
    .catch((err: Error) => this.callback(err))
    .finally(removeResolver);
};

export default webpack5Loader;
