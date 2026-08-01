---
'@wyw-in-js/nextjs': patch
---

Fix Next.js webpack builds that combine App and Pages Routers by preserving WyW class names in every CSS issuer layer and skipping direct transforms of `node_modules` dependencies.
