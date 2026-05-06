# `@wyw-in-js/turbopack-loader`

Turbopack-compatible loader for WyW-in-JS.

This package is designed to be used via Next.js `turbopack.rules`.

## Eval resolver modes

`eval.resolver: 'native'` and the native step of `eval.resolver: 'hybrid'` use `oxc-resolver` with automatic
`tsconfig.json` discovery.

When this loader is configured through `@wyw-in-js/nextjs`, string aliases from `turbopack.resolveAlias` or
`experimental.turbo.resolveAlias` are forwarded into native resolver options. Direct `turbopack.rules` usage should mirror
Turbopack-only aliases in `oxcOptions.resolver.alias` or use `hybrid` so the bundler fallback can resolve them.

## Output strategy

When a file produces CSS, the loader:

- writes `*.wyw-in-js.module.css` next to the source file (only if content changed, atomically);
- injects `import './<file>.wyw-in-js.module.css'` into the transformed module;
- wraps selectors in `:global(...)` so Next's CSS Modules pipeline does not rename WyW-generated class names.
