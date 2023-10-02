import type { Artifact, Replacement, Rules } from '@wyw-in-js/shared';

export type WYWTransformMetadata = {
  dependencies: string[];
  processors: { artifacts: Artifact[] }[];
  replacements: Replacement[];
  rules: Rules;
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
