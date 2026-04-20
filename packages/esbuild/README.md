# @wyw-in-js/esbuild

The package contains WyW-in-JS plugin for [esbuild](https://esbuild.github.io/).

## Installation

```shell
# npm
npm i -D @wyw-in-js/esbuild
# yarn
yarn add --dev @wyw-in-js/esbuild
# pnpm
pnpm add -D @wyw-in-js/esbuild
# bun
bun add -d @wyw-in-js/esbuild
```

## Usage

```js
import wyw from '@wyw-in-js/esbuild';
import esbuild from 'esbuild';

const isProduction = process.env.NODE_ENV === 'production';

esbuild
  .build({
    entryPoints: ['src/index.ts'],
    outdir: 'dist',
    bundle: true,
    minify: isProduction,
    plugins: [wyw({ sourceMap: isProduction })],
  })
  .catch(() => process.exit(1));
```

## Additional Babel transformations

`@wyw-in-js/esbuild` runs WyW evaluation after an `esbuild.transform()` step, so some Babel plugins may not be able to
operate on the original TS/JSX source.

Enable `babelTransform` to apply `babelOptions` to the original source code before the esbuild/WyW pipeline:

```js
wyw({
  babelTransform: true,
  babelOptions: {
    plugins: [
      // your custom Babel plugins
    ],
  },
});
```

Order: `Babel(source) → esbuild.transform() → WyW transform`.

Note: `babelOptions` are still used by WyW when parsing/evaluating modules. With `babelTransform: true`, the same plugins
may run both before esbuild and again during WyW's internal Babel stage. Prefer idempotent plugins.

This is an opt-in feature and may increase build times, so it's recommended to keep `filter` narrow.

## Disabling vendor prefixing

Stylis adds vendor-prefixed CSS by default. To disable it (and reduce CSS size), pass `prefixer: false`:

```js
wyw({
  prefixer: false,
});
```

## Transforming libraries in `node_modules`

By default, the esbuild plugin skips transforming files from `node_modules` for performance.

To transform a specific library, enable `transformLibraries` and narrow `filter`:

```js
wyw({
  transformLibraries: true,
  filter: /node_modules\\/(?:@fluentui)\\//,
});
```

To get details about supported options by the plugin, please check [documentation](https://wyw-in-js.dev/bundlers/esbuild).
