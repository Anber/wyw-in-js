---
'@wyw-in-js/shared': patch
'@wyw-in-js/transform': patch
---

Optimize pure re-export barrel files by caching barrel manifests and rewriting imports to leaf modules before CommonJS emission. This avoids repeated `only` supersede churn on large barrel files while preserving existing runtime behavior for non-optimized paths. Also add explicit package exports for `@wyw-in-js/shared` so Bun resolves its ESM entry consistently during workspace tests.
