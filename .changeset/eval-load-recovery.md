---
'@wyw-in-js/transform': patch
---

Improve evaluation diagnostics and recovery for transient missing imports.

Missing imports during evaluation now report the importing file, requested specifier, resolved path, and original error cause. The evaluator also evicts modules left in failed VM states and refreshes broker-side load tracking, so a subsequent evaluation can recover after the missing file is created instead of rethrowing stale module status errors.
