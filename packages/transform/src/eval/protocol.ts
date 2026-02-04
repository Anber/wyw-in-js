import type {
  EvalResolverKind,
  EvalWarning,
  FeatureFlags,
  ImportOverrides,
} from '@wyw-in-js/shared';

import type { SerializedError, SerializedValue } from './serialize';

export type EvalRunnerInitPayload = {
  evalOptions: {
    mode: 'strict' | 'loose';
    require: 'warn-and-run' | 'error' | 'off';
    globals: Record<string, unknown>;
    importOverrides?: ImportOverrides;
    root?: string;
    extensions?: string[];
  };
  features: FeatureFlags<'happyDOM'>;
  entrypoint: string;
};

export type EvalRequest = {
  id: string;
};

export type EvalResultPayload = {
  values: Record<string, SerializedValue> | null;
  modules?: Record<string, Record<string, SerializedValue>>;
};

export type ResolveRequestPayload = {
  specifier: string;
  importerId: string;
  kind: EvalResolverKind;
};

export type ResolveResultPayload = {
  resolvedId: string | null;
  external?: boolean;
  error?: SerializedError;
};

export type LoadRequestPayload = {
  id: string;
  importerId?: string | null;
  request?: string | null;
};

export type LoadResultPayload = {
  id: string;
  code?: string;
  map?: unknown;
  hash?: string;
  only?: string[];
  exports?: Record<string, SerializedValue>;
  error?: SerializedError;
};

export type InitMessage = {
  type: 'INIT';
  id: string;
  payload: EvalRunnerInitPayload;
};

export type InitAckMessage = {
  type: 'INIT_ACK';
  id: string;
  error?: SerializedError;
};

export type EvalMessage = {
  type: 'EVAL';
  id: string;
  payload: EvalRequest;
};

export type EvalResultMessage = {
  type: 'EVAL_RESULT';
  id: string;
  payload: EvalResultPayload;
  error?: SerializedError;
};

export type ResolveMessage = {
  type: 'RESOLVE';
  id: string;
  payload: ResolveRequestPayload;
};

export type ResolveResultMessage = {
  type: 'RESOLVE_RESULT';
  id: string;
  payload: ResolveResultPayload;
};

export type LoadMessage = {
  type: 'LOAD';
  id: string;
  payload: LoadRequestPayload;
};

export type LoadResultMessage = {
  type: 'LOAD_RESULT';
  id: string;
  payload: LoadResultPayload;
};

export type WarnMessage = {
  type: 'WARN';
  payload: EvalWarning;
};

export type RunnerToMainMessage =
  | ResolveMessage
  | LoadMessage
  | WarnMessage
  | InitAckMessage
  | EvalResultMessage;

export type MainToRunnerMessage =
  | InitMessage
  | EvalMessage
  | ResolveResultMessage
  | LoadResultMessage;
