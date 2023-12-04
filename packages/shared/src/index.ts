export { Debugger } from 'debug';

export { asyncResolveFallback, syncResolve } from './asyncResolveFallback';
export { hasEvalMeta } from './hasEvalMeta';
export { findPackageJSON } from './findPackageJSON';
export { isBoxedPrimitive } from './isBoxedPrimitive';
export { IVariableContext } from './IVariableContext';
export { enableDebug, logger } from './logger';
export { isFeatureEnabled } from './options/isFeatureEnabled';
export { slugify } from './slugify';
export { ValueType } from './types';

export type {
  ClassNameSlugVars,
  ClassNameFn,
  StrictOptions,
  EvalRule,
  Evaluator,
  FeatureFlag,
  EvaluatorConfig,
  FeatureFlags,
  VariableNameFn,
} from './options/types';
export type {
  Artifact,
  BuildCodeFrameErrorFn,
  ConstValue,
  ExpressionValue,
  FunctionValue,
  ICSSRule,
  LazyValue,
  Location,
  Replacement,
  Replacements,
  Rules,
  WYWEvalMeta,
} from './types';
