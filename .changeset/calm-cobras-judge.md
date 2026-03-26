---
'@wyw-in-js/transform': patch
---

Coalesce `only` updates while a transform is already in flight so expanding export requests does not repeatedly restart the same entrypoint work.
