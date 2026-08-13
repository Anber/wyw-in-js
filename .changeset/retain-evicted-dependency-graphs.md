---
'@wyw-in-js/transform': patch
---

Stop repeatedly invalidating cached transforms after an unchanged dependency entrypoint is evicted. Retain a lightweight dependency graph snapshot so transitive file changes are still detected without keeping the full entrypoint alive.
