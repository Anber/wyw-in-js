---
'@wyw-in-js/transform': patch
---

Preserve static values when processor expressions are nested inside opaque wrappers. Mutation analysis now projects their eval-time replacements through surrounding containers while retaining hazards from other wrapper inputs and processor interpolations.
