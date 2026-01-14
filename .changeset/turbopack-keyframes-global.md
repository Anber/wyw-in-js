---
'@wyw-in-js/turbopack-loader': patch
---

Avoid injecting `:global()` into `@keyframes` preludes when globalizing CSS Modules output so LightningCSS can parse the result.
