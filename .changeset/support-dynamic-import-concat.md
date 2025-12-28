---
'@wyw-in-js/shared': patch
'@wyw-in-js/transform': patch
'@wyw-in-js/vite': patch
'@wyw-in-js/rollup': patch
'@wyw-in-js/webpack-loader': patch
---

Handle unknown/dynamic import specifiers without transform-time crashes, add `importOverrides` (mock/noShake/unknown policy), and emit a deduped warning only when eval reaches Node resolver fallback (bundler-native where possible).
