---
'@wyw-in-js/shared': patch
'@wyw-in-js/transform': patch
---

Stabilize the v2 Oxc-backed transform and evaluator path for v1-compatible output.

This covers import/order preservation, export shaking, CommonJS and live-binding emit, runtime source map composition, processor-added imports, hoisted template dependencies, React wrapper handling, Node 22 parse compatibility, dependency graph cache invalidation, and hot-path parse/cache performance.
