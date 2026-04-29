---
"@wyw-in-js/transform": patch
"@wyw-in-js/shared": patch
---

Inline statically resolvable imported literals, fixed objects, zero-argument helper returns, compound component alias metadata, same-module alias metadata, primitive processor metadata, and static metadata helper chains during Oxc pre-evaluation. The optimization is controlled by the default-enabled `features.staticImportValues` flag.
