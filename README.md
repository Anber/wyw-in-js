<div align="center">
  <h1>WyW-in-JS</h1>
  <p>A Toolkit for Zero-Runtime CSS-in-JS Libraries</p>
</div>

# Introduction

wyw-in-js, short for "Whatever-you-want-in-JS," is the world's first toolkit for creating various zero-runtime CSS(and more)-in-JS libraries. In essence, it empowers developers to build their own solutions with arbitrary syntax and functionality, offering complete independence from specific implementations.

### Origins

WyW-in-JS grew out of the CSS-in-JS library [Linaria][1], where the core extraction model proved that styles can be authored in JavaScript and emitted ahead of time. The project separates that machinery from any one styling API, so libraries can define their own syntax, evaluation rules, and artifacts. That foundation continues to serve Linaria, can model processor APIs such as [Griffel][2] `makeStyles`, and is used end-to-end by [dx-styles][3] for compiler-backed CSS-in-TS in design systems.

### Key Features

- Provides an API for creating custom processors (e.g., `css` and `styled` in [Linaria][1], `makeStyles` in [Griffel][2], or `css`, `recipe`, and `slotRecipe` in [dx-styles][3]).
- Supports a wide range of syntaxes, including tagged templates, function calls, and object literals.
- Computes any unprepared JavaScript during the build phase, generating a set of artifacts that processors can transform into styles (or other outputs, depending on the processor).
- Allows for arbitrary JavaScript in style definitions, including imports, conditionals, and loops.
- Powers design-system primitives such as deterministic style-object classes, variant recipes, multipart slot recipes, token contracts, themes, and runtime CSS variable assignment.
- Supports compile-time styling workflows such as generated CSS artifacts, class-name composition, nested selectors, at-rules, and opt-in RTL overrides.
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

- Node.js `>=22.0.0`.
- WyW-in-JS packages are ESM-only. If your tooling is still CJS, use dynamic `import()` or migrate configs to ESM.
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
[3]: https://dx-styles.dev
