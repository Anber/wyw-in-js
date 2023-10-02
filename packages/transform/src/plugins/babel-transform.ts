import type { BabelFile, PluginObj } from '@babel/core';

import { logger, syncResolve } from '@wyw-in-js/shared';

import type { Core } from '../babel';
import { TransformCacheCollection } from '../cache';
import { transformSync } from '../transform';
import { loadLinariaOptions } from '../transform/helpers/loadLinariaOptions';
import type { ICollectAction, SyncScenarioForAction } from '../transform/types';
import type { IPluginState, PluginOptions } from '../types';

import { collector } from './collector';

export default function babelTransform(
  babel: Core,
  options: Partial<PluginOptions>
): PluginObj<IPluginState> {
  const cache = new TransformCacheCollection();
  const debug = logger.extend('babel-transform');

  return {
    name: '@wyw-in-js/transform/babel-transform',
    pre(file: BabelFile) {
      // eslint-disable-next-line require-yield
      function* collect(
        this: ICollectAction
      ): SyncScenarioForAction<ICollectAction> {
        const { valueCache } = this.data;
        const { loadedAndParsed } = this.entrypoint;
        const { pluginOptions } = this.services.options;
        if (loadedAndParsed.evaluator === 'ignored') {
          throw new Error('entrypoint was ignored');
        }

        collector(file, pluginOptions, valueCache);

        return {
          ast: loadedAndParsed.ast,
          code: loadedAndParsed.code,
        };
      }

      debug('start %s', file.opts.filename);

      const pluginOptions = loadLinariaOptions(options);

      transformSync(
        {
          babel,
          cache,
          options: {
            filename: file.opts.filename!,
            root: file.opts.root ?? undefined,
            inputSourceMap: file.opts.inputSourceMap ?? undefined,
            pluginOptions,
          },
        },
        file.code,
        syncResolve,
        {
          collect,
        }
      );
    },
    visitor: {},
    post(file: BabelFile) {
      debug('end %s', file.opts.filename);
    },
  };
}
