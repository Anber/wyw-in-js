---
'@wyw-in-js/esbuild': patch
---

Fix handling of empty `cssText` results: return the transformed JS even when WyW extracts no CSS from a module.
