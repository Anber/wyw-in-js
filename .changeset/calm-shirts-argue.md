---
"@wyw-in-js/transform": patch
---

Strip Vite React Refresh helpers (`$RefreshReg$`/`$RefreshSig$`) when they are injected as local functions by `@vitejs/plugin-react@5.1.x`, preventing unintended code execution during eval.
