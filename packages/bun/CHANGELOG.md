# @wyw-in-js/bun

## 1.0.3

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@1.0.3

## 1.0.2

### Patch Changes

- Bump versions
- Updated dependencies
  - @wyw-in-js/shared@1.0.2
  - @wyw-in-js/transform@1.0.2

## 1.0.1

### Patch Changes

- 5882514: Fix publishing so released packages don't contain `workspace:*` dependency ranges (npm install compatibility).
- Updated dependencies
  - @wyw-in-js/shared@1.0.1
  - @wyw-in-js/transform@1.0.1

## 1.0.0

### Major Changes

- 94c5efa: Release **1.0.0** introduces no breaking changes compared to previous releases.

  This release establishes a stable baseline for future development, including upcoming releases focused on performance
  and build-time optimizations.

### Patch Changes

- c54c0a9: Add Bun bundler plugin for wyw-in-js.
- 16a64ad: Document the `prefixer: false` option to disable vendor prefixing in bundler plugins.
- ae740bf: Add `transformLibraries` option to allow transforming selected dependencies inside `node_modules` (opt-in; still recommended to narrow via filters).
- Updated dependencies
  - @wyw-in-js/shared@1.0.0
  - @wyw-in-js/transform@1.0.0
