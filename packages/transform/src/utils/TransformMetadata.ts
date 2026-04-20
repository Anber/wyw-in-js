import type { BaseProcessor } from '@wyw-in-js/processor-utils';
import type { Artifact, Location, Replacement, Rules } from '@wyw-in-js/shared';

type TransformMetadataProcessor = Pick<
  BaseProcessor,
  'artifacts' | 'className' | 'displayName' | 'location'
>;

export type WYWTransformMetadata = {
  dependencies: string[];
  processors: TransformMetadataProcessor[];
  replacements: Replacement[];
  rules: Rules;
};

export type WYWTransformProcessorMetadata = {
  artifacts: Artifact[];
  className: string;
  displayName: string;
  start: Location | null | undefined;
};

export type WYWTransformResultMetadata = Omit<
  WYWTransformMetadata,
  'processors'
> & {
  processors: WYWTransformProcessorMetadata[];
};

export type WYWTransformManifest = WYWTransformResultMetadata & {
  cssFile?: string;
  source: string;
  version: 1;
};

export const withTransformMetadata = (
  value: unknown
): value is { wywInJS: WYWTransformMetadata } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { wywInJS: unknown }).wywInJS === 'object';

export const getTransformMetadata = (
  value: unknown
): WYWTransformMetadata | undefined => {
  if (withTransformMetadata(value) && value.wywInJS !== null) {
    const metadata = value.wywInJS;
    // eslint-disable-next-line no-param-reassign
    delete (value as { wywInJS: unknown }).wywInJS;
    return metadata;
  }

  return undefined;
};

export const toTransformResultMetadata = (
  metadata: WYWTransformMetadata,
  dependencies: string[]
): WYWTransformResultMetadata => ({
  dependencies,
  processors: metadata.processors.map((processor) => ({
    artifacts: processor.artifacts.map(
      ([type, data]) => [type, data] as Artifact
    ),
    className: processor.className,
    displayName: processor.displayName,
    start: processor.location?.start ?? null,
  })),
  replacements: [...metadata.replacements],
  rules: { ...metadata.rules },
});

export const createTransformManifest = (
  metadata: WYWTransformResultMetadata,
  context: Pick<WYWTransformManifest, 'cssFile' | 'source'>
): WYWTransformManifest => ({
  ...metadata,
  ...context,
  version: 1,
});

export const stringifyTransformManifest = (
  manifest: WYWTransformManifest
): string => `${JSON.stringify(manifest, null, 2)}\n`;
