# @wyw-in-js/bun

The package contains WyW-in-JS plugin for [Bun](https://bun.sh/) bundler.

## Installation

```shell
# npm
npm i -D @wyw-in-js/bun
# yarn
yarn add --dev @wyw-in-js/bun
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

To get details about supported options by the plugin, please check [documentation](https://wyw-in-js.dev/bundlers/bun).

