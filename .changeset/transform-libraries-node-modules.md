---
'@wyw-in-js/bun': patch
'@wyw-in-js/esbuild': patch
'@wyw-in-js/vite': patch
---

Add `transformLibraries` option to allow transforming selected dependencies inside `node_modules` (opt-in; still recommended to narrow via filters).

