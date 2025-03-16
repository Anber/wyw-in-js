---
'@wyw-in-js/transform': patch
---

The check for unsupported dynamic imports has been moved to the evaluation stage. We don't want to fail if this import is unreachable during evaluation. Fixes #126.
