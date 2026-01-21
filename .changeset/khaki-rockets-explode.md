---
'@wyw-in-js/transform': patch
---

Fix processor skip handling to accept `Symbol('skip')` by description (instead of object identity), and warn once when the symbol identity mismatches `BaseProcessor.SKIP` to help diagnose duplicated dependencies.
