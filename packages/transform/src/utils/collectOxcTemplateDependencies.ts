export type {
  OxcStaticImportReference,
  OxcStaticValue,
  OxcStaticValueCandidate,
  StaticBindings,
} from './collectOxcTemplateDependencies/types';
export { lookupStaticBinding } from './collectOxcTemplateDependencies/staticBindings';
export { createOxcStaticCallableValue } from './collectOxcTemplateDependencies/staticEvaluator';
export {
  collectOxcExpressionDependencies,
  collectOxcTemplateDependencies,
  evaluateOxcStaticExpression,
  evaluateOxcStaticExpressionAt,
  isOxcStaticSerializableValue,
} from './collectOxcTemplateDependencies/expressionExtraction';
