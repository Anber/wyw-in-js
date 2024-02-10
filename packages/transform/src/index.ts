export { slugify } from '@wyw-in-js/shared';

export { createFileReporter } from './debug/fileReporter';
export type { IFileReporterOptions } from './debug/fileReporter';
export { default as babelTransformPlugin } from './plugins/babel-transform';
export { default as preeval } from './plugins/preeval';
export {
  getTransformMetadata,
  withTransformMetadata,
} from './utils/TransformMetadata';
export type { WYWTransformMetadata } from './utils/TransformMetadata';
export { Module, DefaultModuleImplementation } from './module';
export { default as shaker } from './shaker';
export { transform } from './transform';
export {
  isUnprocessedEntrypointError,
  UnprocessedEntrypointError,
} from './transform/actions/UnprocessedEntrypointError';
export * from './types';
export { EvaluatedEntrypoint } from './transform/EvaluatedEntrypoint';
export type { IEvaluatedEntrypoint } from './transform/EvaluatedEntrypoint';
export { parseFile } from './transform/Entrypoint.helpers';
export type { LoadAndParseFn } from './transform/Entrypoint.types';
export { baseHandlers } from './transform/generators';
export { prepareCode } from './transform/generators/transform';
export { Entrypoint } from './transform/Entrypoint';
export { transformUrl } from './transform/generators/createStylisPreprocessor';
export {
  asyncResolveImports,
  syncResolveImports,
} from './transform/generators/resolveImports';
export { loadWywOptions } from './transform/helpers/loadWywOptions';
export { withDefaultServices } from './transform/helpers/withDefaultServices';
export type { Services } from './transform/types';
export { EventEmitter } from './utils/EventEmitter';
export type {
  EntrypointEvent,
  OnEvent,
  OnActionStartArgs,
  OnActionFinishArgs,
} from './utils/EventEmitter';
export { isNode } from './utils/isNode';
export { getFileIdx } from './utils/getFileIdx';
export { applyProcessors } from './utils/getTagProcessor';
export { getVisitorKeys } from './utils/getVisitorKeys';
export type { VisitorKeys } from './utils/getVisitorKeys';
export { peek } from './utils/peek';
export { TransformCacheCollection } from './cache';
export { findIdentifiers } from './utils/findIdentifiers';
