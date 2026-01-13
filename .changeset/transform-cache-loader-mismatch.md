---
'@wyw-in-js/transform': patch
'@wyw-in-js/vite': patch
---

Fix cache invalidation when a file is first read from the filesystem and later provided by a bundler/loader, preventing stale transforms and related Vite build/dev issues.
