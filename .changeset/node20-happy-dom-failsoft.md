---
'@wyw-in-js/babel-preset': minor
'@wyw-in-js/bun': minor
'@wyw-in-js/cli': minor
'@wyw-in-js/esbuild': minor
'@wyw-in-js/nextjs': minor
'@wyw-in-js/parcel-transformer': minor
'@wyw-in-js/processor-utils': minor
'@wyw-in-js/rollup': minor
'@wyw-in-js/shared': minor
'@wyw-in-js/transform': minor
'@wyw-in-js/turbopack-loader': minor
'@wyw-in-js/vite': minor
'@wyw-in-js/webpack-loader': minor
---

Drop Node.js <20 support (Node 18 is EOL).

If DOM emulation is enabled (`features.happyDOM`), but `happy-dom` cannot be loaded via `require()` (ESM-only), WyW will
fall back to running without DOM and print a one-time warning with guidance.
