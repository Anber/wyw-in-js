---
'@wyw-in-js/transform': patch
---

Fix the transform shaker so exports pruned from output can still remain as local declarations when surviving code depends on them, including chained references, enums, and mixed variable export declarations.
