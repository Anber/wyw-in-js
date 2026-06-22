export type { Debugger } from './debugger';

export { asyncResolveFallback, syncResolve } from './asyncResolveFallback';
export { asyncResolverFactory } from './asyncResolverFactory';
export { hasEvalMeta } from './hasEvalMeta';
export { findPackageJSON } from './findPackageJSON';
export { isBoxedPrimitive } from './isBoxedPrimitive';
export { enableDebug, logger } from './logger';
export { isFeatureEnabled } from './options/isFeatureEnabled';
export {
  mergeOxcResolverAlias,
  toNativeResolverAlias,
} from './options/nativeResolverOptions';
export type { NativeResolverAlias } from './options/nativeResolverOptions';
export { slugify } from './slugify';
export { ValueType } from './types';

export type { IVariableContext } from './IVariableContext';
export type {
  ClassNameSlugVars,
  ClassNameFn,
  CodeRemoverOptions,
  EvalErrorMode,
  EvalOptionsV2,
  EvalRequireMode,
  EvalResolverKind,
  EvalResolverMode,
  EvalRuntime,
  EvalStrategy,
  EvalWarning,
  EvalWarningCode,
  ImportLoader,
  ImportLoaderContext,
  ImportLoaders,
  ImportOverride,
  ImportOverrides,
  OxcOptions,
  TagResolverMeta,
  StrictOptions,
  EvalRule,
  EvaluatorOptions,
  TransformEngineOptions,
  Evaluator,
  FeatureFlag,
  EvaluatorConfig,
  FeatureFlags,
  VariableNameFn,
  WywInJsProcessorOptions,
} from './options/types';
export type {
  Artifact,
  AstExpression,
  AstNode,
  BigIntLiteral,
  BooleanLiteral,
  BuildCodeFrameErrorFn,
  ConstValue,
  DecimalLiteral,
  ExpressionValue,
  FunctionValue,
  Identifier,
  ICSSRule,
  LazyValue,
  Location,
  NullLiteral,
  NumericLiteral,
  Replacement,
  Replacements,
  Rules,
  SourceLocation,
  StringLiteral,
  WYWEvalMeta,
} from './types';
