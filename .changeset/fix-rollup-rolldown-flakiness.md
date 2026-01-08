---
'@wyw-in-js/rollup': patch
---

Serialize `transform()` calls by default to avoid flakiness with bundlers that execute Rollup plugin hooks concurrently (e.g. tsdown/rolldown).

