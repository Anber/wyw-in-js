import type { BabelFileResult } from '@babel/core';

import type { Replacements, Rules } from '@wyw-in-js/shared';

import type { WYWTransformResultMetadata } from '../../utils/TransformMetadata';

export interface IExtracted {
  cssSourceMapText: string;
  cssText: string;
  replacements: Replacements;
  rules: Rules;
}

export interface IWorkflowActionNonLinariaResult {
  code: string;
  sourceMap: BabelFileResult['map'];
}

export interface IWorkflowActionLinariaResult
  extends IExtracted,
    IWorkflowActionNonLinariaResult {
  dependencies: string[];
  metadata?: WYWTransformResultMetadata;
}
