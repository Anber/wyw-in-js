# @wyw-in-js/vite

The package contains WyW-in-JS plugin for [Vite](https://vitejs.dev/).

## Installation

```shell
# npm
npm i -D @wyw-in-js/vite
# yarn
yarn add --dev @wyw-in-js/vite
# pnpm
pnpm add -D @wyw-in-js/vite
# bun
bun add -d @wyw-in-js/vite
```

## Usage

After installation, add the plugin to your `vite.config.js`:

```js
import { defineConfig } from 'vite';
import wyw from '@wyw-in-js/vite';

export default defineConfig({
  // ...
  plugins: [wyw()],
});
```

## Transforming libraries in `node_modules`

By default, the Vite plugin skips transforming files from `node_modules` for performance.

To transform a specific library, enable `transformLibraries` and narrow `include`/`exclude`:

```js
wyw({
  transformLibraries: true,
  include: [/node_modules\\/(?:@fluentui)\\//],
});
```

## Disabling vendor prefixing

Stylis adds vendor-prefixed CSS by default. To disable it (and reduce CSS size), pass `prefixer: false`:

```js
wyw({
  prefixer: false,
});
```

## `import.meta.env` during evaluation

WyW-in-JS evaluates part of your code at build time to extract styles. The Vite plugin injects Vite's `import.meta.env` values
into the evaluation context so `import.meta.env.*` works as expected.

To get details about supported options by the plugin, please check [documentation](https://wyw-in-js.dev/bundlers/vite).
