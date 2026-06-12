export { babelShaker, emitCommonJS, shakeToESM } from './babelShaker';
export { default as babelTransformPlugin } from './plugins/babel-transform';
export { default as preeval } from './plugins/preeval';
export { findIdentifiers } from './utils/findIdentifiers';
export { applyProcessors } from './utils/getTagProcessor';
export type { IPluginState, MissedBabelCoreTypes } from './legacyBabelTypes';
