---
'@wyw-in-js/shared': minor
'@wyw-in-js/transform': minor
'@wyw-in-js/esbuild': patch
'@wyw-in-js/nextjs': patch
'@wyw-in-js/vite': patch
'@wyw-in-js/webpack-loader': patch
---

Rename the eval resolver mode from `node` to `native` and resolve native eval imports with `oxc-resolver`. Hybrid eval resolution now tries the custom resolver, then native resolution, then the bundler resolver.

Native eval resolution now discovers `tsconfig.json` by default. Vite, esbuild, webpack, and Next Turbopack integrations forward static string aliases from their bundler config into native resolver options, while preserving explicitly configured `oxcOptions.resolver.alias` entries.
