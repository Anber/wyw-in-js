import type { BabelFile, PluginPass } from '@babel/core';
import type { NodePath } from '@babel/traverse';
import type { File, Program } from '@babel/types';

import type { BaseProcessor } from '@wyw-in-js/processor-utils';

import type { WYWTransformMetadata } from './utils/TransformMetadata';
import type { Dependencies } from './types';

export interface IPluginState extends PluginPass {
  dependencies: Dependencies;
  file: BabelFile & {
    metadata: {
      wywInJS?: WYWTransformMetadata;
    };
  };
  processors: BaseProcessor[];
}

export type MissedBabelCoreTypes = {
  File: new (
    options: { filename: string },
    file: { ast: File; code: string }
  ) => { path: NodePath<Program> };
};
