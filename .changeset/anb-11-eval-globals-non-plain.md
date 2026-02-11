---
"@wyw-in-js/transform": patch
---

Make `eval.globals` handling deterministic for non-plain objects.

- Reject unsupported non-plain objects in `eval.globals` (for example `Date`, `Map`, `Set`, class instances) with path-aware errors.
- Keep globals codec plain-object traversal strict to avoid silent prototype/state loss.
- Add regression tests and docs clarifying supported `eval.globals` value shapes.
