<iframe src="https://github.com/sponsors/Anber/card" title="Sponsor Anber" height="225" width="600" style="border: 0;"></iframe>

<div align="center">
  <h1>WyW-in-JS</h1>
  <p>A Toolkit for Zero-Runtime CSS-in-JS Libraries</p>
</div>

# Introduction

wyw-in-js, short for "Whatever-you-want-in-JS," is the world's first toolkit for creating various zero-runtime CSS(and more)-in-JS libraries. In essence, it empowers developers to build their own solutions with arbitrary syntax and functionality, offering complete independence from specific implementations.

### Origins

This library evolved from the CSS-in-JS library [Linaria][1], with the aim of decoupling from a specific implementation and providing developers with a comprehensive toolkit for crafting their own solutions with custom syntax and features.

### Key Features

- Provides an API for creating custom processors (e.g., `css` and `styled` in [Linaria][1] or `makeStyles` in [Griffel][2]).
- Supports a wide range of syntaxes, including tagged templates, function calls, and object literals.
- Computes any unprepared JavaScript during the build phase, generating a set of artifacts that processors can transform into styles (or other outputs, depending on the processor).
- Allows for arbitrary JavaScript in style definitions, including imports, conditionals, and loops.
- Offers loaders and plugins for popular bundlers (including Webpack, Vite, esbuild) and frameworks (Next.js), ensuring compatibility with various build systems.

## Documentation

- Website: https://wyw-in-js.dev/
- Stability: https://wyw-in-js.dev/stability
- Troubleshooting: https://wyw-in-js.dev/troubleshooting
- Configuration: https://wyw-in-js.dev/configuration
- How it works: https://wyw-in-js.dev/how-it-works
- Bundlers: https://wyw-in-js.dev/bundlers
- CLI: https://wyw-in-js.dev/cli

## Requirements

- Node.js `>=20.0.0` (Node 18 is EOL and not supported).
- Bun `>=1.0.0` (supported via `@wyw-in-js/bun` and for running the workspace with Bun).

## CLI Quickstart

Install:

```sh
npm i -D @wyw-in-js/cli
yarn add -D @wyw-in-js/cli
pnpm add -D @wyw-in-js/cli
bun add -d @wyw-in-js/cli
```

Extract CSS and inject imports into your compiled output:

```sh
wyw-in-js \
  --config ./wyw-in-js.config.js \
  --source-root ./src \
  --out-dir ./dist/wyw-css \
  --insert-css-requires ./dist \
  --modules esnext \
  --transform \
  "src/**/*.{ts,tsx,js,jsx}"
```

See https://wyw-in-js.dev/cli for all options, migration notes from `@linaria/cli`, and notes about dependencies (including `happy-dom`).

[1]: https://github.com/callstack/linaria
[2]: https://github.com/microsoft/griffel
