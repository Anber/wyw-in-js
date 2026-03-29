---
'@wyw-in-js/transform': patch
---

Avoid unnecessary reexport expansion for `__wywPreval`-only entrypoints and isolate cached action trees per resolver context to prevent concurrent transform crashes.
