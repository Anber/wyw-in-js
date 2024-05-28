/**
 * This file contains a Webpack loader for WYW-in-JS.
 * It uses the transform.ts function to generate class names from source code,
 * returns transformed code without template literals and attaches generated source maps
 */

import path from 'path';

import type { RawSourceMap } from 'source-map';
import type { RawLoaderDefinitionFunction } from 'webpack';

import { logger } from '@wyw-in-js/shared';
import type { Preprocessor, Result } from '@wyw-in-js/transform';
import { transform, TransformCacheCollection } from '@wyw-in-js/transform';

import { sharedState } from './WYWinJSDebugPlugin';
import type { ICache } from './cache';
import { getCacheInstance } from './cache';

export { WYWinJSDebugPlugin } from './WYWinJSDebugPlugin';

const outputCssLoader = require.resolve('./outputCssLoader');

export type LoaderOptions = {
  cacheProvider?: string | ICache;
  extension?: string;
  nextjsConfig?: {
    asyncResolve?: (token: string, importer: string) => Promise<string | null>;
    isModule?: boolean;
    outputCss?: boolean;
    placeholderCssFile: string;
  };
  preprocessor?: Preprocessor;
  sourceMap?: boolean;
};
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
    extension = '.wyw-in-js.css',
    cacheProvider,
    nextjsConfig,
    ...rest
  } = this.getOptions() || {};

  const outputFileName = this.resourcePath.replace(/\.[^.]+$/, extension);
  const resolveModule = this.getResolve({ dependencyType: 'esm' });

  const asyncResolve = async (
    token: string,
    importer: string
  ): Promise<string> => {
    if (nextjsConfig?.asyncResolve) {
      const value = await nextjsConfig.asyncResolve(token, importer);
      if (value) {
        return value;
      }
    }
    const context = path.isAbsolute(importer)
      ? path.dirname(importer)
      : path.join(process.cwd(), path.dirname(importer));
    return new Promise((resolve, reject) => {
      resolveModule(context, token, (err, result) => {
        if (err) {
          reject(err);
        } else if (result) {
          this.addDependency(result);
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
      root: process.cwd(),
      preprocessor,
      pluginOptions: rest,
    },
    cache,
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

          if (nextjsConfig) {
            try {
              const { isModule = true, outputCss = true } = nextjsConfig;
              if (!outputCss) {
                this.callback(null, result.code, result.sourceMap ?? undefined);
                return;
              }
              const cssPart = `${
                nextjsConfig.placeholderCssFile
              }?${encodeURIComponent(
                JSON.stringify({
                  filename: this.resourcePath,
                  source: cssText.replaceAll('!important', '__IMP__'), // webpack has a special handling for `!` and we want to handle `!important` in CSS
                })
              )}`;
              this.callback(
                null,
                `${result.code}\n\n${
                  isModule ? 'import ' : 'require('
                }${JSON.stringify(cssPart)}${!isModule ? ')' : ''}`,
                result.sourceMap ?? undefined
              );
            } catch (err) {
              this.callback(err as Error);
            }
          } else {
            try {
              const cacheInstance = await getCacheInstance(cacheProvider);

              await cacheInstance.set(this.resourcePath, cssText);

              await cacheInstance.setDependencies?.(
                this.resourcePath,
                this.getDependencies()
              );

              const request = `${outputFileName}!=!${outputCssLoader}?cacheProvider=${encodeURIComponent(
                typeof cacheProvider === 'string' ? cacheProvider : ''
              )}!${this.resourcePath}`;
              const stringifiedRequest = JSON.stringify(
                this.utils.contextify(this.context || this.rootContext, request)
              );

              this.callback(
                null,
                `${result.code}\n\nrequire(${stringifiedRequest});`,
                result.sourceMap ?? undefined
              );
            } catch (err) {
              this.callback(err as Error);
            }
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
