import type { PluginObj } from '@babel/core';

import type { Core } from '../babel';
import type { IPluginState, PluginOptions } from '../types';

export default function babelTransform(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _babel: Core,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _options: Partial<PluginOptions>
): PluginObj<IPluginState> {
  return {
    name: '@wyw-in-js/transform/babel-transform',
    pre() {
      throw new Error(
        '[wyw-in-js] @wyw-in-js/transform/babel-transform is not supported in v2 (async evaluator). Use bundler integrations or the async transform() API instead.'
      );
    },
    visitor: {},
  };
}
