---
'@wyw-in-js/nextjs': patch
'@wyw-in-js/turbopack-loader': patch
---

Fix Next.js Turbopack production builds by routing generated WyW CSS through a Turbopack query loader path on versions that support query conditions, while preserving sidecar output as the fallback for older Turbopack configs.
