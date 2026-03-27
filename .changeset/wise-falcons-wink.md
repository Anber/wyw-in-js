---
'@wyw-in-js/transform': patch
---

Reuse already resolved leaf dependencies after barrel import rewriting so mixed-barrel optimization avoids re-resolving generated direct imports during the rewritten resolve pass.
