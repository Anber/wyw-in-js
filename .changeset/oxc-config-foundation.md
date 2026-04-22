---
'@wyw-in-js/shared': patch
'@wyw-in-js/transform': patch
---

Add the public Oxc configuration foundation without changing the current Babel-backed runtime path.

This introduces `oxcOptions`, per-rule `EvalRule.oxcOptions`, and the opt-in `hybrid` eval resolver mode contract. The default resolver remains `bundler`, and the new hybrid resolver strategy is scaffolded for later Oxc parser/evaluator cutover work.
