---
'@wyw-in-js/transform': patch
---

Lower explicit resource management syntax in ESM build output so the v2 package
can be parsed on Node 22. The previous v2 alpha build left raw
`using abortSignal` declarations in `@wyw-in-js/transform` ESM artifacts.
