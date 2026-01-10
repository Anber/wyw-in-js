---
"@wyw-in-js/babel-preset": patch
"@wyw-in-js/bun": patch
"@wyw-in-js/cli": patch
"@wyw-in-js/esbuild": patch
"@wyw-in-js/nextjs": patch
"@wyw-in-js/parcel-transformer": patch
"@wyw-in-js/processor-utils": patch
"@wyw-in-js/rollup": patch
"@wyw-in-js/shared": patch
"@wyw-in-js/transform": patch
"@wyw-in-js/turbopack-loader": patch
"@wyw-in-js/vite": patch
"@wyw-in-js/webpack-loader": patch
---

Fix publishing so released packages don't contain `workspace:*` dependency ranges (npm install compatibility).
