import { dirname } from 'path';

import { Transformer } from '@parcel/plugin';
import SourceMapModule from '@parcel/source-map';

import { asyncResolveFallback, findPackageJSON } from '@wyw-in-js/shared';
import { transform, TransformCacheCollection } from '@wyw-in-js/transform';

const cache = new TransformCacheCollection();
const SourceMap =
  (SourceMapModule as unknown as { default?: typeof SourceMapModule })
    .default ?? SourceMapModule;
const getTransformRoot = (filename: string, projectRoot: string) => {
  const packageJSON = findPackageJSON('.', filename);
  return packageJSON ? dirname(packageJSON) : projectRoot;
};

export default new Transformer({
  async transform({ asset, logger, options, resolve }) {
    if (!asset.isSource) {
      return [asset];
    }

    const transformRoot = getTransformRoot(asset.filePath, options.projectRoot);
    const originalCode = await asset.getCode();
    const originalMap = await asset.getMap();
    const originalVlqMap = originalMap?.toVLQ();
    const inputSourceMap = originalVlqMap
      ? {
          ...originalVlqMap,
          version: originalVlqMap.version ?? 3,
          sources: [...originalVlqMap.sources],
          names: [...originalVlqMap.names],
          sourcesContent: undefined,
          file: originalVlqMap.file ?? asset.filePath,
        }
      : undefined;

    const result = await transform(
      {
        cache,
        emitWarning: (message: string) => {
          logger.warn({ message, origin: '@wyw-in-js/parcel-transformer' });
        },
        options: {
          filename: asset.filePath,
          inputSourceMap,
          root: transformRoot,
        },
      },
      originalCode,
      async (what: string, importer: string, stack: string[]) => {
        try {
          return await resolve(importer, what, { specifierType: 'esm' });
        } catch (error) {
          try {
            return await asyncResolveFallback(what, importer, stack);
          } catch {
            throw error;
          }
        }
      }
    );

    if (result.dependencies) {
      for (const dependency of result.dependencies) {
        asset.invalidateOnFileChange(dependency);
      }
    }

    asset.setCode(result.code);

    if (result.sourceMap) {
      const map = new SourceMap(options.projectRoot);
      map.addVLQMap(result.sourceMap);
      asset.setMap(map);
    } else {
      asset.setMap(null);
    }

    if (!result.cssText) {
      return [asset];
    }

    const cssKey = `${asset.id}::wyw-in-js.css`;

    asset.addDependency({
      specifier: cssKey,
      specifierType: 'esm',
    });

    return [
      asset,
      {
        type: 'css',
        content: `${result.cssText}\n`,
        env: asset.env,
        sideEffects: true,
        uniqueKey: cssKey,
      },
    ];
  },
});
