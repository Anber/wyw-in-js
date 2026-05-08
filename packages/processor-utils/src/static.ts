import type { SourceLocation } from './ast';
import type { IFileContext, IOptions } from './utils/types';
import type { IInterpolation } from './types';
import type { TagSource } from './BaseProcessor';

export type ProcessorStaticSerializableValue = {
  kind: 'serializable';
  value: unknown;
};

export type ProcessorStaticClassNameValue = {
  className: string;
  kind: 'class-name';
  value?: unknown;
};

export type ProcessorStaticSelectorChainValue = {
  className: string;
  kind: 'selector-chain';
  selectors: string[];
  value?: unknown;
};

export type ProcessorStaticRuntimeCallbackValue = {
  kind: 'runtime-callback';
  source?: string;
  value?: unknown;
};

export type ProcessorStaticOpaqueComponentValue = {
  className?: string;
  kind: 'opaque-component';
  value?: unknown;
};

export type ProcessorStaticUnresolvedValue = {
  details?: Readonly<Record<string, unknown>>;
  kind: 'unresolved';
  reason: string;
};

export type ProcessorStaticValue =
  | ProcessorStaticClassNameValue
  | ProcessorStaticOpaqueComponentValue
  | ProcessorStaticRuntimeCallbackValue
  | ProcessorStaticSelectorChainValue
  | ProcessorStaticSerializableValue
  | ProcessorStaticUnresolvedValue;

export type ProcessorStaticDependency = Readonly<{
  imported?: string;
  local?: string;
  reason?: string;
  source?: string;
}>;

export type ProcessorStaticDebugReason = Readonly<{
  details?: Readonly<Record<string, unknown>>;
  reason: string;
}>;

export type ProcessorStaticMetadata = Readonly<{
  className: string;
  displayName: string;
  isReferenced: boolean;
  location: SourceLocation | null;
  slug: string;
  tagSource: TagSource;
}>;

export type ProcessorStaticContext = Readonly<{
  fileContext: Readonly<IFileContext>;
  metadata: ProcessorStaticMetadata;
  options: Readonly<IOptions>;
  addDependency(dependency: ProcessorStaticDependency): void;
  debug(reason: ProcessorStaticDebugReason): void;
  unresolved(
    reason: string,
    details?: Readonly<Record<string, unknown>>
  ): ProcessorStaticUnresolvedValue;
}>;

export type ProcessorStaticInterpolationResolver = (
  interpolation: IInterpolation,
  value: ProcessorStaticValue,
  context: ProcessorStaticContext
) => ProcessorStaticValue | null | undefined;

export type ProcessorStaticTagTargetResolver = (
  target: ProcessorStaticValue,
  context: ProcessorStaticContext
) => ProcessorStaticValue | null | undefined;
