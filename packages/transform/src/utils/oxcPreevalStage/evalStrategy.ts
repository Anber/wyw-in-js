import type { OxcPreevalOptions } from './types';

export const getEvalStrategy = (options: OxcPreevalOptions) =>
  options.eval?.strategy ?? 'hybrid';

export const usesStaticEvaluation = (options: OxcPreevalOptions): boolean =>
  getEvalStrategy(options) !== 'execute';
