---
'@wyw-in-js/rollup': patch
'@wyw-in-js/vite': patch
---

Fix async module resolution by calling the bundler `resolve()` with the correct plugin context.
