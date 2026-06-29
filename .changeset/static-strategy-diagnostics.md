---
"@wyw-in-js/transform": patch
---

Improve `eval.strategy: "static"` failure diagnostics. Errors now lead with the source expression the developer wrote (e.g. `themeVars.panelBg`) instead of bare `_exp` codegen placeholders, surface the specific per-value reason the resolver determined (unanalyzable import, non-serializable value, missing/undefined export, or runtime function call), and group values by shared cause with `(×N)` dedupe so a real build no longer prints hundreds of near-identical low-signal lines.
