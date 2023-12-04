import type { ConfigAPI, TransformCaller } from '@babel/core';
import { babelTransformPlugin } from '@wyw-in-js/transform';
import type { PluginOptions } from '@wyw-in-js/transform';

function isEnabled(caller?: TransformCaller & { evaluate?: true }) {
  return caller?.name !== 'wyw-in-js' || caller.evaluate === true;
}

export default function wywInJS(babel: ConfigAPI, options: PluginOptions) {
  if (!babel.caller(isEnabled)) {
    return {};
  }

  return {
    plugins: [[babelTransformPlugin, options]],
  };
}
