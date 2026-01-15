---
'@wyw-in-js/transform': patch
---

Fix Babel plugin/preset merging when keys are absolute paths from pnpm store (`node_modules/.pnpm/...`) so different packages don't get treated as duplicates.
