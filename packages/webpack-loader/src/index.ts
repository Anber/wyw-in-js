/**
 * This file contains a Webpack loader for WYW-in-JS.
 * It uses the transform.ts function to generate class names from source code,
 * returns transformed code without template literals and attaches generated source maps
 */

import path from 'path';

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
  const resolveModule = this.getResolve({ dependencyType: 'esm' });

  const asyncResolve = (token: string, importer: string): Promise<string> => {
    const context = path.isAbsolute(importer)
      ? path.dirname(importer)
      : path.join(process.cwd(), path.dirname(importer));
    return new Promise((resolve, reject) => {
      resolveModule(context, token, (err, result) => {
        if (err) {
          reject(err);
        } else if (result) {
          const filePath = stripQueryAndHash(result);
          if (path.isAbsolute(filePath)) {
            this.addDependency(filePath);
          }
          resolve(result);
        } else {
          reject(new Error(`Cannot resolve ${token}`));
        }
      });
    });
  };

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

          try {
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

            const resourcePathWithQuery = `${
              this.resourcePath
            }?wyw=${encodeURIComponent(extension.replace(/^\./, ''))}`;

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
          } catch (err) {
            this.callback(err as Error);
          }

          return;
        }

        this.callback(null, result.code, result.sourceMap ?? undefined);
      },
      (err: Error) => this.callback(err)
    )
    .catch((err: Error) => this.callback(err));
};

export default webpack5Loader;
