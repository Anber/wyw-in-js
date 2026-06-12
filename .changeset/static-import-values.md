---
'@wyw-in-js/transform': minor
'@wyw-in-js/shared': minor
---

Enable static-first value resolution by default with `eval.strategy: "hybrid"`.

WyW can now resolve many imported literals, fixed objects, compiled TypeScript enum objects, zero-argument helper returns, compound component aliases, processor metadata values, and static metadata helper chains without starting the evaluator or loading the full module graph.

The default `hybrid` mode keeps evaluator fallback for values that are not statically provable. Use `eval.strategy: "execute"` for evaluator-only compatibility and `eval.strategy: "static"` to reject fallback.

Add `staticBindings` config for declaring additional statically-known imported values and pure helper functions.
