---
'@wyw-in-js/vite': patch
---

Avoid manually calling `optimizeDeps()` from the plugin resolve path when Vite returns a missing optimized-deps entry. This prevents Vite 7 deprecation spam and reduces dev server startup overhead.
