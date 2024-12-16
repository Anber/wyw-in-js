/**
 * This file contains a Vite loader for wyw-in-js.
 * It uses the transform.ts function to generate class names from source code,
 * returns transformed code without template literals and attaches generated source maps
 */

import { existsSync } from 'fs';
import path from 'path';

import type {
  FilterPattern,
  ModuleNode,
  Plugin,
  ResolvedConfig,
  ViteDevServer,
} from 'vite';
import { createFilter, optimizeDeps } from 'vite';

import { asyncResolverFactory, logger, syncResolve } from '@wyw-in-js/shared';
import type {
  IFileReporterOptions,
  PluginOptions,
  Preprocessor,
} from '@wyw-in-js/transform';
import {
  createFileReporter,
  getFileIdx,
  transform,
  TransformCacheCollection,
} from '@wyw-in-js/transform';

type VitePluginOptions = {
  debug?: IFileReporterOptions | false | null | undefined;
  exclude?: FilterPattern;
  include?: FilterPattern;
  preprocessor?: Preprocessor;
  sourceMap?: boolean;
} & Partial<PluginOptions>;

export { Plugin };

export default function wywInJS({
  debug,
  include,
  exclude,
  sourceMap,
  preprocessor,
  ...rest
}: VitePluginOptions = {}): Plugin {
  const filter = createFilter(include, exclude);
  const cssLookup: { [key: string]: string } = {};
  const cssFileLookup: { [key: string]: string } = {};
  let config: ResolvedConfig;
  let devServer: ViteDevServer;

  const { emitter, onDone } = createFileReporter(debug ?? false);

  // <dependency id, targets>
  const targets: { dependencies: string[]; id: string }[] = [];
  const cache = new TransformCacheCollection();

  const createAsyncResolver = asyncResolverFactory(
    async (
      resolved: {
        external: boolean | 'absolute';
        id: string;
      } | null,
      what,
      importer,
      stack
    ) => {
      if (resolved) {
        if (resolved.external) {
          // If module is marked as external, Rollup will not resolve it,
          // so we need to resolve it ourselves with default resolver
          return syncResolve(what, importer, stack);
        }

        // Vite adds param like `?v=667939b3` to cached modules
        const resolvedId = resolved.id.split('?', 1)[0];

        if (resolvedId.startsWith('\0')) {
          // \0 is a special character in Rollup that tells Rollup to not include this in the bundle
          // https://rollupjs.org/guide/en/#outputexports
          return null;
        }

        if (!existsSync(resolvedId)) {
          await optimizeDeps(config);
        }

        return resolvedId;
      }

      throw new Error(`Could not resolve ${what}`);
    },
    (what, importer) => [what, importer]
  );

  return {
    name: 'wyw-in-js',
    enforce: 'post',
    buildEnd() {
      onDone(process.cwd());
    },
    configResolved(resolvedConfig: ResolvedConfig) {
      config = resolvedConfig;
    },
    configureServer(_server) {
      devServer = _server;
    },
    load(url: string) {
      const [id] = url.split('?', 1);
      return cssLookup[id];
    },
    /* eslint-disable-next-line consistent-return */
    resolveId(importeeUrl: string) {
      const [id] = importeeUrl.split('?', 1);
      if (cssLookup[id]) return id;
      return cssFileLookup[id];
    },
    handleHotUpdate(ctx) {
      // it's module, so just transform it
      if (ctx.modules.length) return ctx.modules;

      // Select affected modules of changed dependency
      const affected = targets.filter(
        (x) =>
          // file is dependency of any target
          x.dependencies.some((dep) => dep === ctx.file) ||
          // or changed module is a dependency of any target
          x.dependencies.some((dep) => ctx.modules.some((m) => m.file === dep))
      );
      const deps = affected.flatMap((target) => target.dependencies);

      // eslint-disable-next-line no-restricted-syntax
      for (const depId of deps) {
        cache.invalidateForFile(depId);
      }

      return affected
        .map((target) => devServer.moduleGraph.getModuleById(target.id))
        .concat(ctx.modules)
        .filter((m): m is ModuleNode => !!m);
    },
    async transform(code: string, url: string) {
      const [id] = url.split('?', 1);

      // Do not transform ignored and generated files
      if (url.includes('node_modules') || !filter(url) || id in cssLookup)
        return;

      const log = logger.extend('vite').extend(getFileIdx(id));

      log('transform %s', id);

      const transformServices = {
        options: {
          filename: id,
          root: process.cwd(),
          preprocessor,
          pluginOptions: rest,
        },
        cache,
        eventEmitter: emitter,
      };

      const result = await transform(
        transformServices,
        code,
        createAsyncResolver(this.resolve)
      );

      let { cssText, dependencies } = result;

      // Heads up, there are three cases:
      // 1. cssText is undefined, it means that file was not transformed
      // 2. cssText is empty, it means that file was transformed, but it does not contain any styles
      // 3. cssText is not empty, it means that file was transformed and it contains styles

      if (typeof cssText === 'undefined') {
        return;
      }

      if (cssText === '') {
        /* eslint-disable-next-line consistent-return */
        return {
          code: result.code,
          map: result.sourceMap,
        };
      }

      dependencies ??= [];

      const cssFilename = path
        .normalize(`${id.replace(/\.[jt]sx?$/, '')}.wyw-in-js.css`)
        .replace(/\\/g, path.posix.sep);

      const cssRelativePath = path
        .relative(config.root, cssFilename)
        .replace(/\\/g, path.posix.sep);

      const cssId = `/${cssRelativePath}`;

      if (sourceMap && result.cssSourceMapText) {
        const map = Buffer.from(result.cssSourceMapText).toString('base64');
        cssText += `/*# sourceMappingURL=data:application/json;base64,${map}*/`;
      }

      cssLookup[cssFilename] = cssText;
      cssFileLookup[cssId] = cssFilename;

      result.code += `\nimport ${JSON.stringify(cssFilename)};\n`;

      for (let i = 0, end = dependencies.length; i < end; i++) {
        // eslint-disable-next-line no-await-in-loop
        const depModule = await this.resolve(dependencies[i], url, {
          isEntry: false,
        });
        if (depModule) dependencies[i] = depModule.id;
      }
      const target = targets.find((t) => t.id === id);
      if (!target) targets.push({ id, dependencies });
      else target.dependencies = dependencies;

      if (devServer?.moduleGraph) {
        const module = devServer.moduleGraph.getModuleById(cssFilename);

        if (module) {
          devServer.reloadModule(module);
        }
      }
      /* eslint-disable-next-line consistent-return */
      return { code: result.code, map: result.sourceMap };
    },
  };
}
