---
'@wyw-in-js/transform': minor
'@wyw-in-js/shared': minor
---

Inline statically resolvable imported literals, fixed objects, compiled TypeScript enum objects, zero-argument helper returns, compound component alias metadata, same-module and post-declaration alias metadata, primitive processor metadata, and static metadata helper chains during Oxc pre-evaluation. Static-first value resolution is enabled by default with `eval.strategy: "hybrid"`, while `eval.strategy: "static"` rejects evaluator fallback.

Fold the previous top-level `evaluate` toggle into `eval.strategy`; use `eval.strategy: "execute"` for evaluator-only value resolution.

Add `staticBindings` config for opt-in static values and pure helper functions used by static import value inlining.

Cache per-file static metadata pre-evaluation results so multiple static exports from the same module do not repeat the same processor pre-evaluation work.
