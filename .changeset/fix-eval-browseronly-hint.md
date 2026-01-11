---
'@wyw-in-js/transform': patch
---

Improve eval error diagnostics: when build-time evaluation fails due to browser-only globals (e.g. `window`), include a hint about using `importOverrides` / moving runtime-only code out of evaluated modules.
