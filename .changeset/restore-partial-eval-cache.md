---
'@wyw-in-js/transform': patch
---

Restore partial evaluated-cache reuse during Oxc prepare/eval processing.

This fixes a regression where cached evaluated dependencies could be reprocessed unnecessarily when prepare-stage imports widened the requested export set with `__wywPreval`, even if the dependency did not export it.

The transform pipeline now reuses cached evaluated exports unless `__wywPreval` is actually available, and concurrent processing requests wait for the in-flight entrypoint result before continuing. This restores downstream cache semantics while keeping the Oxc runtime path in place.
