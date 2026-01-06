---
'@wyw-in-js/transform': patch
---

Avoid emitting `/*#__PURE__*/` on non-call/new expressions to prevent Rollup warnings during builds.
