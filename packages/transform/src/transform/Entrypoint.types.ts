import type {
  Debugger,
  Evaluator,
  TransformEngineOptions,
} from '@wyw-in-js/shared';

import type { Services } from './types';
import type { WYWTransformMetadata } from '../utils/TransformMetadata';

export type ParsedAst = unknown;

export interface IEntrypointCode {
  readonly ast: ParsedAst;
  code: string;
  evalConfig: TransformEngineOptions;
  evaluator: Evaluator;
}

export interface IIgnoredEntrypoint {
  readonly ast?: ParsedAst;
  readonly code?: string;
  evaluator: 'ignored';
  reason: 'extension' | 'rule';
}

export interface IEntrypointDependency {
  only: string[];
  resolved: string | null;
  source: string;
}

export interface IPreevalResult {
  ast: ParsedAst | null;
  baseCode?: string;
  code: string;
  dependencyNames?: string[];
  metadata: WYWTransformMetadata | null;
  staticDependencies?: string[];
  staticNullWYWMetaExtendsHelpers?: string[];
  staticValueCache?: Map<string, unknown>;
  staticValueCandidates?: Array<{
    imports: Array<{
      imported: 'default' | string;
      importLocal?: string;
      local: string;
      source: string;
    }>;
    name: string;
    source: string;
  }>;
}

export type LoadAndParseFn = (
  services: Services,
  name: string,
  loadedCode: string | undefined,
  log: Debugger
) => IEntrypointCode | IIgnoredEntrypoint;
