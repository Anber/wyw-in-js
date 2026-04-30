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
  code: string;
  metadata: WYWTransformMetadata | null;
}

export type LoadAndParseFn = (
  services: Services,
  name: string,
  loadedCode: string | undefined,
  log: Debugger
) => IEntrypointCode | IIgnoredEntrypoint;
