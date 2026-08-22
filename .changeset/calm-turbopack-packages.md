---
'@wyw-in-js/turbopack-loader': patch
'@wyw-in-js/transform': patch
---

Preserve resolved transform dependency paths so the Turbopack loader can register them without resolving package specifiers a second time.
