---
'@wyw-in-js/transform': patch
---

Revalidate evaluated dependencies against disk during entrypoint freshness checks, and rethrow non-missing filesystem errors instead of treating them as cache invalidations.
