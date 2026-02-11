---
"@wyw-in-js/transform": patch
---

Harden `eval.globals` serialization markers to avoid user-data collisions and improve function restore diagnostics.

- Use a versioned encoded envelope for function/symbol globals in evaluator init payloads.
- Validate function sources during encode and fail fast for unsupported native/bound functions.
- Add path-aware restore errors for corrupted encoded globals.
