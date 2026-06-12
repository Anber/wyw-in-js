---
'@wyw-in-js/shared': minor
'@wyw-in-js/transform': minor
---

Expose the public Oxc configuration surface used by the v2 transform path.

This introduces `oxcOptions` and per-rule `EvalRule.oxcOptions` so projects and bundler integrations can configure parser, transform, and resolver behavior for the Oxc-backed pipeline.
