---
'@wyw-in-js/cli': minor
'@wyw-in-js/processor-utils': minor
'@wyw-in-js/transform': minor
'@wyw-in-js/vite': minor
---

Add a supported processor diagnostics seam that lets library-owned processors emit structured non-fatal warnings through WyW.

This adds:

- `BaseProcessor.addDiagnostic()` and typed diagnostics helpers in `@wyw-in-js/processor-utils`
- normalized `diagnostics` output from `@wyw-in-js/transform`
- diagnostics reporting in `@wyw-in-js/vite` and `@wyw-in-js/cli`

Existing hard failures and metadata sidecar behavior stay intact.
