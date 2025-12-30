---
'@wyw-in-js/transform': patch
---

Fix missing CSS emission for tags inside named function expressions (e.g. `export const a = function a() { return css\`\`; }`).

