---
"@wyw-in-js/transform": minor
"@wyw-in-js/shared": minor
---

Inline statically resolvable imported literals, fixed objects, compiled TypeScript enum objects, zero-argument helper returns, compound component alias metadata, same-module and post-declaration alias metadata, primitive processor metadata, and static metadata helper chains during Oxc pre-evaluation. The optimization is controlled by the opt-in `features.staticImportValues` flag.

Cache per-file static metadata pre-evaluation results so multiple static exports from the same module do not repeat the same processor pre-evaluation work.
