---
'@wyw-in-js/cli': minor
'@wyw-in-js/shared': minor
'@wyw-in-js/transform': minor
'@wyw-in-js/vite': minor
---

Add opt-in metadata manifest plumbing across `@wyw-in-js/shared`, `@wyw-in-js/transform`, `@wyw-in-js/vite`, and `@wyw-in-js/cli`.

When `outputMetadata` is enabled:

- `@wyw-in-js/transform` now returns normalized, public metadata alongside the existing transform result.
- `@wyw-in-js/vite` emits `.wyw-in-js.json` sidecar assets during build.
- `@wyw-in-js/cli` writes matching `.wyw-in-js.json` sidecar files and supports an `--output-metadata` flag.

This keeps default JS/CSS output unchanged while exposing a stable manifest path for library-owned tooling.
