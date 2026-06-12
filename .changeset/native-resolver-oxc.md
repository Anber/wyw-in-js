---
'@wyw-in-js/shared': minor
'@wyw-in-js/transform': minor
'@wyw-in-js/esbuild': patch
'@wyw-in-js/nextjs': patch
'@wyw-in-js/vite': patch
'@wyw-in-js/webpack-loader': patch
---

Add native Oxc-backed import resolution for build-time evaluation.

Hybrid eval resolution now tries a custom resolver first, then native resolution, then the bundler resolver. Native resolution is powered by `oxc-resolver`, discovers `tsconfig.json` by default, and receives static string aliases from Vite, esbuild, webpack, and Next Turbopack integrations while preserving explicitly configured `oxcOptions.resolver.alias` entries.
