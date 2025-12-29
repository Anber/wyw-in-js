---
'@wyw-in-js/transform': patch
'@wyw-in-js/webpack-loader': patch
---

Fix handling of import resource queries (e.g. `?raw`, `?url`) to avoid crashes and allow minimal eval-time loaders.
