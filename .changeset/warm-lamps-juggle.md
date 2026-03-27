---
'@wyw-in-js/transform': patch
---

Invalidate cached barrel analysis when leaf export sets change, so warm rebuilds do not reuse stale rewritten `export *` output.
