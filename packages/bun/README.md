# @wyw-in-js/bun

The package contains WyW-in-JS plugin for [Bun](https://bun.sh/) bundler.

## Installation

```shell
# npm
npm i -D @wyw-in-js/bun
# yarn
yarn add --dev @wyw-in-js/bun
# pnpm
pnpm add -D @wyw-in-js/bun
# bun
bun add -d @wyw-in-js/bun
```

## Usage

```js
import wyw from '@wyw-in-js/bun';

await Bun.build({
  entrypoints: ['src/index.ts'],
  outdir: 'dist',
  plugins: [wyw()],
});
```

## Transforming libraries in `node_modules`

By default, the Bun plugin skips transforming files from `node_modules` for performance.

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

To get details about supported options by the plugin, please check [documentation](https://wyw-in-js.dev/bundlers/bun).
