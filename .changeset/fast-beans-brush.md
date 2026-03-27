---
'@wyw-in-js/transform': patch
---

Keep invalidation-only dependencies for rewritten barrel imports out of normal dependency merging so optimized imports no longer need `noShake` as much to avoid repeated dependency churn.
