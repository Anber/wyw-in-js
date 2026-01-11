---
'@wyw-in-js/transform': patch
---

When expanding `export * from` to named re-exports, never include `default` (ESM export-star semantics). This avoids invalid code like duplicate default exports.
