---
'@wyw-in-js/shared': minor
'@wyw-in-js/transform': minor
---

Expose the public Oxc configuration surface for the v2 transform path.

This introduces `oxcOptions`, per-rule `EvalRule.oxcOptions`, and the opt-in `hybrid` eval resolver mode contract used by the Oxc-first pipeline. The default resolver remains `bundler`, while native eval resolution is backed by Oxc resolver options.
