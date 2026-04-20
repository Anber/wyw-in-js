# `@wyw-in-js/turbopack-loader`

Turbopack-compatible loader for WyW-in-JS.

This package is designed to be used via Next.js `turbopack.rules`.

## Output strategy

When a file produces CSS, the loader:

- writes `*.wyw-in-js.module.css` next to the source file (only if content changed, atomically);
- injects `import './<file>.wyw-in-js.module.css'` into the transformed module;
- wraps selectors in `:global(...)` so Next's CSS Modules pipeline does not rename WyW-generated class names.

