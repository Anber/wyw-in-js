import type { BabelFile, PluginPass } from '@babel/core';
import type { NodePath } from '@babel/traverse';
import type { File, Program } from '@babel/types';
import type { RawSourceMap } from 'source-map';

import type { BaseProcessor } from '@wyw-in-js/processor-utils';
import type {
  Debugger,
  Replacement,
  Rules,
  StrictOptions,
} from '@wyw-in-js/shared';

import type { WYWTransformMetadata } from './utils/TransformMetadata';

export type PluginOptions = StrictOptions & {
  configFile?: string | false;
  stage?: Stage;
};

export type ParentEntrypoint = {
  evaluated: boolean;
  log: Debugger;
  name: string;
  parents: ParentEntrypoint[];
  seqId: number;
};

export type Dependencies = string[];

export interface IPluginState extends PluginPass {
  dependencies: Dependencies;
  file: BabelFile & {
    metadata: {
      wywInJS?: WYWTransformMetadata;
    };
  };
  processors: BaseProcessor[];
}

export interface ITransformFileResult {
  code: string;
  metadata: WYWTransformMetadata | null;
}

export type Stage = 'preeval' | 'collect';

export type Result = {
  code: string;
  cssSourceMapText?: string;
  cssText?: string;
  dependencies?: string[];
  replacements?: Replacement[];
  rules?: Rules;
  sourceMap?: RawSourceMap | null;
};

export type Options = {
  filename: string;
  inputSourceMap?: RawSourceMap;
  outputFilename?: string;
  pluginOptions?: Partial<PluginOptions>;
  preprocessor?: Preprocessor;
  root?: string;
};

export type PreprocessorFn = (selector: string, cssText: string) => string;
export type Preprocessor = 'none' | 'stylis' | PreprocessorFn | void;

export type MissedBabelCoreTypes = {
  File: new (
    options: { filename: string },
    file: { ast: File; code: string }
  ) => { path: NodePath<Program> };
};

export type JSONValue =
  | null
  | string
  | number
  | boolean
  | JSONObject
  | JSONArray;

export interface JSONObject {
  [x: string]: JSONValue;
}

export type JSONArray = Array<JSONValue>;

export type Serializable = JSONValue;

/**
 * CSS-related types
 */
