# @wyw-in-js/rollup

The package contains WyW-in-JS plugin for [Rollup](https://rollupjs.org/).
Supports Rollup v1, v2, v3, and v4.

## Installation

```shell
# npm
npm i -D @wyw-in-js/rollup
# yarn
yarn add --dev @wyw-in-js/rollup
# pnpm
pnpm add -D @wyw-in-js/rollup
# bun
bun add -d @wyw-in-js/rollup
```

## Usage

After installation, add the plugin to your `rollup.config.js`:

```js
import wyw from '@wyw-in-js/rollup';

export default {
  plugins: [
    wyw({
      sourceMap: process.env.NODE_ENV !== 'production',
    }),
  ],
};
```

## Eval resolver modes

`eval.resolver: 'native'` and the native step of `eval.resolver: 'hybrid'` use `oxc-resolver` with automatic
`tsconfig.json` discovery.

Rollup aliases are commonly implemented by resolver plugins, so they are resolved only by the bundler fallback. Use
`hybrid` when evaluated imports rely on Rollup plugins. Use `native` only when `oxc-resolver` can resolve all evaluated
imports, or mirror plugin aliases in `oxcOptions.resolver.alias`.

### Concurrency (tsdown/rolldown)

Some Rollup-compatible bundlers may execute plugin hooks concurrently (e.g. tsdown/rolldown). To keep evaluation deterministic, `@wyw-in-js/rollup` serializes `transform()` calls by default.

To opt out, pass:

```js
wyw({
  serializeTransform: false,
});
```

## Disabling vendor prefixing

Stylis adds vendor-prefixed CSS by default. To disable it (and reduce CSS size), pass `prefixer: false`:

```js
wyw({
  prefixer: false,
});
```

To get details about supported options by the plugin, please check [documentation](https://wyw-in-js.dev/bundlers/rollup).
