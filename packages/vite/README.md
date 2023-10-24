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

To get details about supported options by the plugin, please check [documentation](https://wyw-in-js.dev/bundlers/vite).
