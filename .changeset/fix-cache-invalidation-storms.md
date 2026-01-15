---
'@wyw-in-js/transform': patch
'@wyw-in-js/vite': patch
---

Fix cache invalidation storms when loader-provided code differs from filesystem code, keep the Vite resolver stable across repeated `configResolved` calls, and avoid eagerly walking dynamic import targets during eval-only runs (prevents `action handler is already set` and improves build performance on large projects).
