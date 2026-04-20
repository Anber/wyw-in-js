import fs from 'fs';
import path from 'path';

import type { RawSourceMap } from 'source-map';
import type { LoaderContext, RawLoaderDefinitionFunction } from 'webpack';

import { logger } from '@wyw-in-js/shared';
import type { PluginOptions, Result } from '@wyw-in-js/transform';
import { transform, TransformCacheCollection } from '@wyw-in-js/transform';

import { makeCssModuleGlobal } from './css-modules';
import { writeFileIfChanged } from './file-utils';
import { insertImportStatement } from './insert-import';

const DEFAULT_EXTENSION = '.wyw-in-js.module.css';

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
  keepComments?: boolean;
  prefixer?: boolean;
  sourceMap?: boolean;
} & Partial<PluginOptions>;

type Loader = RawLoaderDefinitionFunction<LoaderOptions>;
type ResolveFn = ReturnType<LoaderContext<LoaderOptions>['getResolve']>;

const cache = new TransformCacheCollection();

function convertSourceMap(
  value: RawSourceMap | string | null | undefined,
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

async function resolveWith(
  resolve: ResolveFn,
  context: string,
  request: string
): Promise<string | false> {
  type ResolveCallback = (
    ctx: string,
    req: string,
    cb: (err: Error | null, result?: string) => void
  ) => void;
  type ResolveAsync = (ctx: string, req: string) => Promise<string | false>;

  if (typeof resolve !== 'function') return false;

  if (resolve.length >= 3) {
    return new Promise((ok, fail) => {
      (resolve as unknown as ResolveCallback)(
        context,
        request,
        (err, result) => {
          if (err) fail(err);
          else ok(result ?? false);
        }
      );
    });
  }

  return (resolve as unknown as ResolveAsync)(context, request);
}

const turbopackLoader: Loader = function turbopackLoader(
  content,
  inputSourceMap
) {
  const callbackFromAsync =
    typeof this.async === 'function' ? this.async() : undefined;
  const callback =
    typeof callbackFromAsync === 'function' ? callbackFromAsync : this.callback;

  if (typeof callback !== 'function') {
    throw new Error('Async loader callback is not available');
  }

  logger('turbopack-loader %s', this.resourcePath);

  const { sourceMap, keepComments, prefixer, configFile, ...rest } =
    this.getOptions() || {};

  if (configFile) {
    const configPath = path.isAbsolute(configFile)
      ? configFile
      : path.join(process.cwd(), configFile);
    this.addDependency(configPath);
  }

  const cssFileName = `${path.basename(
    this.resourcePath,
    path.extname(this.resourcePath)
  )}${DEFAULT_EXTENSION}`;
  const cssFilePath = path.join(path.dirname(this.resourcePath), cssFileName);
  const cssImportPath = `./${cssFileName}`;

  const resolveModule = this.getResolve({ dependencyType: 'esm' });

  const asyncResolve = async (token: string, importer: string) => {
    const context = path.isAbsolute(importer)
      ? path.dirname(importer)
      : path.join(process.cwd(), path.dirname(importer));

    const result = await resolveWith(resolveModule, context, token);

    if (!result) {
      throw new Error(`Cannot resolve ${token} from ${context}`);
    }

    const filePath = stripQueryAndHash(result);
    if (path.isAbsolute(filePath)) {
      this.addDependency(filePath);
    }

    return result;
  };

  const transformServices = {
    options: {
      filename: this.resourcePath,
      inputSourceMap: convertSourceMap(inputSourceMap, this.resourcePath),
      pluginOptions: { configFile, ...rest },
      prefixer,
      keepComments,
      root: process.cwd(),
    },
    cache,
    emitWarning: (message: string) => {
      if (typeof this.emitWarning === 'function') {
        this.emitWarning(new Error(message));
      }
    },
  };

  transform(transformServices, content.toString(), asyncResolve)
    .then(async (result: Result) => {
      const rawCssText = result.cssText ?? '';

      if (rawCssText.trim()) {
        let cssText = makeCssModuleGlobal(rawCssText);

        if (sourceMap && typeof result.cssSourceMapText !== 'undefined') {
          cssText += `\n/*# sourceMappingURL=data:application/json;base64,${Buffer.from(
            result.cssSourceMapText
          ).toString('base64')}*/\n`;
        }

        await Promise.all(
          (result.dependencies ?? []).map((dep) =>
            asyncResolve(dep, this.resourcePath)
          )
        );

        writeFileIfChanged(cssFilePath, cssText);

        const importStatement = `import ${JSON.stringify(cssImportPath)};`;
        const finalCode = insertImportStatement(result.code, importStatement);

        callback(null, finalCode, result.sourceMap ?? undefined);
        return;
      }

      if (fs.existsSync(cssFilePath)) {
        writeFileIfChanged(cssFilePath, '');
      }

      callback(null, result.code, result.sourceMap ?? undefined);
    })
    .catch((err: Error) => callback(err));
};

export default turbopackLoader;
