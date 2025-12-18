---
'@wyw-in-js/transform': patch
'@wyw-in-js/vite': patch
---

Handle Vite virtual modules like `/@react-refresh` without filesystem lookups to prevent ENOENT in dev.
