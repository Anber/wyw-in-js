---
'@wyw-in-js/processor-utils': minor
'@wyw-in-js/transform': minor
---

Add an optional processor static evaluation contract. Processors can now describe statically known values as serializable values, class names, selector chains, runtime callbacks, opaque components, or unresolved values with reasons.

The transform static evaluator now consumes this contract before falling back to legacy eval-time replacement metadata, so processors can provide their own static semantics without relying on transform-specific metadata shapes.
