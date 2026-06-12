import type { Replacements, Rules } from '@wyw-in-js/shared';
import type { RawSourceMap } from 'source-map';

import type { WYWTransformDiagnostic } from '../../utils/TransformDiagnostics';
import type { WYWTransformResultMetadata } from '../../utils/TransformMetadata';

export interface IExtracted {
  cssSourceMapText: string;
  cssText: string;
  replacements: Replacements;
  rules: Rules;
}

export interface IWorkflowActionNonLinariaResult {
  code: string;
  sourceMap: RawSourceMap | null | undefined;
}

export interface IWorkflowActionLinariaResult
  extends IExtracted,
    IWorkflowActionNonLinariaResult {
  dependencies: string[];
  diagnostics?: WYWTransformDiagnostic[];
  metadata?: WYWTransformResultMetadata;
}
