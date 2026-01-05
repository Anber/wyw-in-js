---
"@wyw-in-js/transform": patch
---

Avoid repeated evaluator re-runs for large, statically evaluatable modules by promoting them to wildcard `only` on first entrypoint creation.
