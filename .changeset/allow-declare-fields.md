---
'@wyw-in-js/transform': patch
---

Fix Babel TypeScript transform crashing on `declare` class fields by ensuring `allowDeclareFields` is enabled when using the TypeScript preset/plugin.

