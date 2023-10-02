import type { TransformOptions } from '@babel/core';

import type { ClassNameFn, VariableNameFn } from '@wyw-in-js/shared';

export interface IOptions {
  classNameSlug?: string | ClassNameFn;
  displayName: boolean;
  variableNameConfig?: 'var' | 'dashes' | 'raw';
  variableNameSlug?: string | VariableNameFn;
}

export type IFileContext = Pick<TransformOptions, 'root' | 'filename'>;
