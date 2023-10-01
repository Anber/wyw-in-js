export { Debugger } from 'debug';

export { hasMeta } from './hasMeta';
export { isBoxedPrimitive } from './isBoxedPrimitive';
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
  LazyValue,
  Location,
  Replacements,
  WYWMeta,
} from './types';
