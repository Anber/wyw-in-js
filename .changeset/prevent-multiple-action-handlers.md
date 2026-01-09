---
"@wyw-in-js/esbuild": patch
"@wyw-in-js/rollup": patch
"@wyw-in-js/shared": patch
"@wyw-in-js/transform": patch
"@wyw-in-js/vite": patch
"@wyw-in-js/webpack-loader": patch
---

Prevent concurrent transforms from reusing cached actions with different handler instances by stabilizing resolvers across bundlers.

