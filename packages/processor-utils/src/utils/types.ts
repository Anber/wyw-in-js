import type {
  ClassNameFn,
  VariableNameFn,
  WywInJsProcessorOptions,
} from '@wyw-in-js/shared';

export interface IOptions {
  classNameSlug?: string | ClassNameFn;
  displayName: boolean;
  extensions?: string[];
  processors?: WywInJsProcessorOptions;
  variableNameConfig?: 'var' | 'dashes' | 'raw';
  variableNameSlug?: string | VariableNameFn;
}

export type IFileContext = {
  filename?: string | null;
  root?: string | null;
};
