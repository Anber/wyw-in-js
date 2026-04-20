# `@wyw-in-js/nextjs`

Next.js integration for WyW via `@wyw-in-js/webpack-loader`.

This package supports:

- Webpack pipeline (`next dev --webpack`, `next build`) via `@wyw-in-js/webpack-loader`.
- Turbopack pipeline (`next dev`) via `turbopack.rules` and `@wyw-in-js/turbopack-loader`.

## Installation

```sh
# npm
npm i -D @wyw-in-js/nextjs
# yarn
yarn add --dev @wyw-in-js/nextjs
# pnpm
pnpm add -D @wyw-in-js/nextjs
# bun
bun add -d @wyw-in-js/nextjs
```

## Usage

```js
// next.config.js
const { withWyw } = require('@wyw-in-js/nextjs');

module.exports = withWyw({
  // your Next config
});
```

By default, the plugin:

- injects `@wyw-in-js/webpack-loader` into Next's JS/TS pipeline;
- emits styles as `*.wyw-in-js.module.css` so imports are allowed from any module;
- keeps generated class names stable under Next CSS Modules (selectors are emitted as `:global(...)`).
- defaults `babelOptions` to `presets: ['next/babel']` so TS/JSX parsing works out of the box.

## Options

```ts
import type { WywNextPluginOptions } from '@wyw-in-js/nextjs';
```

Use `loaderOptions` to pass options through to `@wyw-in-js/webpack-loader`.

Use `turbopackLoaderOptions` to pass JSON-serializable options to `@wyw-in-js/turbopack-loader` (use `configFile` for
function-based config).

To disable vendor prefixing (Stylis prefixer), set `prefixer: false` in `loaderOptions` and/or `turbopackLoaderOptions`.
