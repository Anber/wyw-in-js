---
'@wyw-in-js/transform': patch
---

Fix a broker/runner cache desync error thrown for the first eval-time load of a module that legitimately shakes down to zero runtime bytes (e.g. a types-only module reached through a barrel's `export *`). The broker previously used an empty `code` string to mean both "here is real, empty content" and "nothing to ship, reuse your cache," so genuinely empty modules were misread as the latter and rejected by the runner on first load. `code` is now omitted from the LoadResult when nothing should be shipped, and only that omission is treated as a signal to reuse a cached variant.
