---
'@wyw-in-js/transform': patch
---

Add opt-in warnings to help identify dynamic and slow imports processed during prepare stage, with an `importOverrides.mock` hint for faster evaluation. Also support minimatch patterns in `importOverrides` keys to override groups of imports.
