---
'@wyw-in-js/shared': patch
---

Avoid installing `@types/debug` as a runtime dependency to prevent leaking global `debug` types into consumer TypeScript projects.
