---
'@wyw-in-js/babel-preset': patch
'@wyw-in-js/bun': patch
'@wyw-in-js/cli': patch
'@wyw-in-js/esbuild': patch
'@wyw-in-js/nextjs': patch
'@wyw-in-js/parcel-transformer': patch
'@wyw-in-js/processor-utils': patch
'@wyw-in-js/rollup': patch
'@wyw-in-js/shared': patch
'@wyw-in-js/transform': patch
'@wyw-in-js/turbopack-loader': patch
'@wyw-in-js/vite': patch
'@wyw-in-js/webpack-loader': patch
---

Drop Node.js <20 support (Node 18 is EOL).

Note: WyW `1.0.0` already effectively required Node 20 in practice; this change makes the support policy explicit and
aligns docs/CI accordingly.

If DOM emulation is enabled (`features.happyDOM`), but `happy-dom` cannot be loaded via `require()` (ESM-only), WyW will
fall back to running without DOM and print a one-time warning with guidance.
