import type { StrictOptions } from '@wyw-in-js/shared';
import type { RawSourceMap } from 'source-map';

import type { WYWTransformMetadata } from '../TransformMetadata';

export type OxcCollectOptions = Pick<
  StrictOptions,
  | 'classNameSlug'
  | 'displayName'
  | 'eval'
  | 'extensions'
  | 'tagResolver'
  | 'variableNameConfig'
> & {
  preserveSideEffectImportOrderLocals?: Set<string>;
  preserveSideEffectImportLocals?: Set<string>;
};

export type OxcCollectResult = {
  code: string;
  map: RawSourceMap;
  metadata: WYWTransformMetadata | null;
};

export type RuntimeReplacement = {
  end: number;
  start: number;
  value: string;
};
