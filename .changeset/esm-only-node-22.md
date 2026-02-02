---
"@wyw-in-js/babel-preset": major
"@wyw-in-js/bun": major
"@wyw-in-js/cli": major
"@wyw-in-js/esbuild": major
"@wyw-in-js/nextjs": major
"@wyw-in-js/parcel-transformer": major
"@wyw-in-js/processor-utils": major
"@wyw-in-js/rollup": major
"@wyw-in-js/shared": major
"@wyw-in-js/transform": major
"@wyw-in-js/turbopack-loader": major
"@wyw-in-js/vite": major
"@wyw-in-js/webpack-loader": major
---

WyW-in-JS packages are now ESM-only and require Node.js >= 22.0.0. CJS `require()` entrypoints were removed; use dynamic
`import()` or migrate configs to ESM.
