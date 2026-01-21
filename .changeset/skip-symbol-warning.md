---
'@wyw-in-js/transform': patch
---

Warn once when a processor throws a `Symbol('skip')` that matches `BaseProcessor.SKIP` by description but not by identity (usually indicates duplicated dependencies).

