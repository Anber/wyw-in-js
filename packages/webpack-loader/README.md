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

To get details about supported options by the plugin, please check [documentation](https://wyw-in-js.dev/bundlers/webpack).
