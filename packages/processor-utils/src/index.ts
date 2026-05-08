export { BaseProcessor } from './BaseProcessor';
export { expressionToCode } from './ast';
export {
  createProcessorDiagnosticArtifact,
  isProcessorDiagnosticArtifact,
  PROCESSOR_DIAGNOSTIC_ARTIFACT,
} from './diagnostics';
export type { ProcessorDiagnosticArtifact } from './diagnostics';
export type {
  ArrayExpression,
  ArrowFunctionExpression,
  AstService,
  BaseAstNode,
  BlockStatement,
  BooleanLiteral,
  CallExpression,
  Expression,
  Identifier,
  MemberExpression,
  NullLiteral,
  NumericLiteral,
  ObjectExpression,
  ObjectProperty,
  SourceLocation,
  StringLiteral,
  TemplateElement,
} from './ast';
export type {
  ProcessorParams,
  TagSource,
  TailProcessorParams,
} from './BaseProcessor';
export type {
  ProcessorStaticClassNameValue,
  ProcessorStaticContext,
  ProcessorStaticDebugReason,
  ProcessorStaticDependency,
  ProcessorStaticInterpolationResolver,
  ProcessorStaticMetadata,
  ProcessorStaticOpaqueComponentValue,
  ProcessorStaticRuntimeCallbackValue,
  ProcessorStaticSelectorChainValue,
  ProcessorStaticSerializableValue,
  ProcessorStaticTagTargetResolver,
  ProcessorStaticUnresolvedValue,
  ProcessorStaticValue,
} from './static';
export * from './types';
export { buildSlug } from './utils/buildSlug';
export type { IOptions, IFileContext } from './utils/types';
export { isValidParams, validateParams } from './utils/validateParams';
export type { MapParams, ParamConstraints } from './utils/validateParams';
export { TaggedTemplateProcessor } from './TaggedTemplateProcessor';
export { toValidCSSIdentifier } from './utils/toValidCSSIdentifier';
