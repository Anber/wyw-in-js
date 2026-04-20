import path from 'path';

import normalize from 'normalize-path';

import type { WYWTransformResultMetadata } from '@wyw-in-js/transform';
import {
  createTransformManifest,
  stringifyTransformManifest,
} from '@wyw-in-js/transform';

type CreateMetadataFileOptions = {
  cssFile?: string;
  metadata: WYWTransformResultMetadata;
  outputRoot: string;
  outputFilename: string;
  sourceRoot: string;
  sourceFilename: string;
};

export function resolveMetadataFilename(outputFilename: string) {
  const extension = path.extname(outputFilename);
  return `${outputFilename.slice(0, -extension.length)}.wyw-in-js.json`;
}

export function createMetadataFile({
  metadata,
  outputRoot,
  outputFilename,
  sourceRoot,
  sourceFilename,
  cssFile,
}: CreateMetadataFileOptions) {
  const filename = resolveMetadataFilename(outputFilename);

  return {
    content: stringifyTransformManifest(
      createTransformManifest(metadata, {
        cssFile: cssFile
          ? normalize(path.relative(outputRoot, cssFile))
          : undefined,
        source: normalize(path.relative(sourceRoot, sourceFilename)),
      })
    ),
    filename,
  };
}
