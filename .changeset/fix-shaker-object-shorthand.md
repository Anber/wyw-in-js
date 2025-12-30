---
'@wyw-in-js/transform': patch
---

Fix shaker removing referenced bindings when dropping unused exports (e.g. object shorthand `{ fallback }`).
