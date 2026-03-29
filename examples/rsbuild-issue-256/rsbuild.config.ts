import path from 'node:path';

import { defineConfig } from '@rsbuild/core';
import { pluginBabel } from '@rsbuild/plugin-babel';
import { pluginReact } from '@rsbuild/plugin-react';
import { WYWinJSDebugPlugin } from '@wyw-in-js/webpack-loader';

export default defineConfig({
  plugins: [
    pluginReact(),
    pluginBabel({
      babelLoaderOptions: (_, { addPresets }) => {
        addPresets([
          ['@babel/preset-react', { runtime: 'automatic' }],
          '@babel/preset-typescript',
        ]);
      },
    }),
  ],
  resolve: {
    alias: {
      'big-barrel-package': path.join(
        __dirname,
        'fixtures',
        'big-barrel',
        'dist',
        'index.js'
      ),
    },
  },
  tools: {
    bundlerChain: (chain, { CHAIN_ID }) => {
      chain.plugin('wyw-debug').use(WYWinJSDebugPlugin, [
        { dir: 'wyw-debug', print: true },
      ]);

      chain.module
        .rule(CHAIN_ID.RULE.JS)
        .use('wyw')
        .after(CHAIN_ID.USE.BABEL)
        .loader('@wyw-in-js/webpack-loader')
        .options({
          babelOptions: {
            babelrc: false,
            configFile: false,
            presets: [
              ['@babel/preset-react', { runtime: 'automatic' }],
              '@babel/preset-typescript',
            ],
          },
          configFile: false,
          evaluate: true,
          extensions: ['.mjs', '.cjs', '.js', '.tsx'],
        });
    },
  },
});
