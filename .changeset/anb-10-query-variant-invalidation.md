---
"@wyw-in-js/transform": patch
---

Fix eval load-cache invalidation for query/hash variants of the same file.

- Track file invalidation with per-file versions instead of single-use tokens.
- Consume invalidation independently for each request id (`?raw`, `?url`, `#hash`, etc.).
- Add regressions in `cache` and `eval-broker` tests covering mixed loader query variants.
