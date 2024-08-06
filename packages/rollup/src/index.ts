/**
 * This file contains a Rollup loader for wyw-in-js.
 * It uses the transform.ts function to generate class names from source code,
 * returns transformed code without template literals and attaches generated source maps
 */

import { createFilter } from '@rollup/pluginutils';
import type { Plugin, ResolvedId } from 'rollup';

import {
  asyncResolverFactory,
  logger,
  slugify,
  syncResolve,
} from '@wyw-in-js/shared';
import type { PluginOptions, Preprocessor, Result } from '@wyw-in-js/transform';
import {
  getFileIdx,
  transform,
  TransformCacheCollection,
} from '@wyw-in-js/transform';

type RollupPluginOptions = {
  exclude?: string | string[];
  include?: string | string[];
  preprocessor?: Preprocessor;
  sourceMap?: boolean;
} & Partial<PluginOptions>;

export default function wywInJS({
  exclude,
  include,
  preprocessor,
  sourceMap,
  ...rest
}: RollupPluginOptions = {}): Plugin {
  const filter = createFilter(include, exclude);
  const cssLookup: { [key: string]: string } = {};
  const cache = new TransformCacheCollection();
  const emptyConfig = {};

  const createAsyncResolver = asyncResolverFactory(
    async (resolved: ResolvedId | null, what, importer, stack) => {
      if (resolved) {
        if (resolved.external) {
          // If module is marked as external, Rollup will not resolve it,
          // so we need to resolve it ourselves with default resolver
          return syncResolve(what, importer, stack);
        }

        // Vite adds param like `?v=667939b3` to cached modules
        const resolvedId = resolved.id.split('?')[0];

        if (resolvedId.startsWith('\0')) {
          // \0 is a special character in Rollup that tells Rollup to not include this in the bundle
          // https://rollupjs.org/guide/en/#outputexports
          return null;
        }

        return resolvedId;
      }

      throw new Error(`Could not resolve ${what}`);
    },
    (what, importer) => [what, importer]
  );

  const plugin: Plugin = {
    name: 'wyw-in-js',
    load(id: string) {
      return cssLookup[id];
    },
    /* eslint-disable-next-line consistent-return */
    resolveId(importee: string) {
      if (importee in cssLookup) return importee;
    },
    async transform(
      code: string,
      id: string
    ): Promise<{ code: string; map: Result['sourceMap'] } | undefined> {
      // Do not transform ignored and generated files
      if (!filter(id) || id in cssLookup) return;

      const log = logger.extend('rollup').extend(getFileIdx(id));

      log('init %s', id);

      const transformServices = {
        options: {
          filename: id,
          root: process.cwd(),
          preprocessor,
          pluginOptions: rest,
        },
        cache,
      };

      const result = await transform(
        transformServices,
        code,
        createAsyncResolver(this.resolve),
        emptyConfig
      );

      if (!result.cssText) return;

      let { cssText } = result;

      const slug = slugify(cssText);
      const filename = `${id.replace(/\.[jt]sx?$/, '')}_${slug}.css`;

      if (sourceMap && result.cssSourceMapText) {
        const map = Buffer.from(result.cssSourceMapText).toString('base64');
        cssText += `/*# sourceMappingURL=data:application/json;base64,${map}*/`;
      }

      cssLookup[filename] = cssText;

      result.code += `\nimport ${JSON.stringify(filename)};\n`;

      /* eslint-disable-next-line consistent-return */
      return { code: result.code, map: result.sourceMap };
    },
  };

  return new Proxy<Plugin>(plugin, {
    get(target, prop) {
      return target[prop as keyof Plugin];
    },

    getOwnPropertyDescriptor(target, prop) {
      return Object.getOwnPropertyDescriptor(target, prop as keyof Plugin);
    },
  });
}
