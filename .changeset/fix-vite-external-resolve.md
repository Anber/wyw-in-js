---
'@wyw-in-js/vite': patch
---

Avoid falling back to Node resolution for Vite `external` resolved file ids (incl. `external: "absolute"`), which could break aliased imports during build-time evaluation (SSR/dev).
