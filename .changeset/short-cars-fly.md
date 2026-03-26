---
'@wyw-in-js/transform': patch
---

Fix transform cache invalidation so entrypoints are evicted when direct or transitive dependencies change, preventing stale eval results from being reused across rebuilds.
