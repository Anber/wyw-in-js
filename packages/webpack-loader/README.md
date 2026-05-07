# @wyw-in-js/webpack

The package contains WyW-in-JS loader for [Webpack](https://webpack.js.org/).

## Installation

```shell
# npm
npm i -D @wyw-in-js/webpack-loader
# yarn
yarn add --dev @wyw-in-js/webpack-loader
# pnpm
pnpm add -D @wyw-in-js/webpack-loader
# bun
bun add -d @wyw-in-js/webpack-loader
```

## Usage

To use the loader with Webpack, please add `@wyw-in-js/webpack-loader` under `module.rules`:

```js
module.exports = {
  test: /\.js$/,
  use: [
    {
      loader: '@wyw-in-js/webpack-loader',
      options: {
        sourceMap: process.env.NODE_ENV !== 'production',
      },
    },
  ],
};
```

## Eval resolver modes

`eval.resolver: 'native'` and the native step of `eval.resolver: 'hybrid'` use `oxc-resolver` with automatic
`tsconfig.json` discovery. The loader also forwards static string entries from webpack `resolve.alias`.

Use `hybrid` when evaluated imports may rely on webpack resolver plugins, query handling, or non-string aliases. Use
`native` only when `oxc-resolver` can resolve all evaluated imports, or mirror webpack-only aliases in
`oxcOptions.resolver.alias`.

## Disabling vendor prefixing

Stylis adds vendor-prefixed CSS by default. To disable it (and reduce CSS size), pass `prefixer: false`:

```js
module.exports = {
  test: /\.js$/,
  use: [
    {
      loader: '@wyw-in-js/webpack-loader',
      options: {
        prefixer: false,
      },
    },
  ],
};
```

To get details about supported options by the plugin, please check [documentation](https://wyw-in-js.dev/bundlers/webpack).
