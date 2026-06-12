import type { StrictOptions } from '@wyw-in-js/shared';

import type { EventEmitter } from '../EventEmitter';
import type { WYWTransformMetadata } from '../TransformMetadata';
import type { OxcStaticValueCandidate } from '../collectOxcTemplateDependencies';

export type OxcPreevalOptions = Pick<
  StrictOptions,
  | 'classNameSlug'
  | 'codeRemover'
  | 'displayName'
  | 'eval'
  | 'extensions'
  | 'features'
  | 'staticBindings'
  | 'tagResolver'
> & { eventEmitter?: EventEmitter };

export type OxcPreevalResult = {
  baseCode: string;
  code: string;
  dependencyNames: string[];
  metadata: WYWTransformMetadata | null;
  processorClassNames: Record<string, string>;
  staticDependencies: string[];
  staticValueCache: Map<string, unknown>;
  staticValueCandidates: OxcStaticValueCandidate[];
};

export type StaticPreevalOverlay = {
  evalDependencyNames: string[];
  staticValueCache: Map<string, unknown>;
  staticValueCandidates: OxcStaticValueCandidate[];
};
