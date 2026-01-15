# @wyw-in-js/nextjs

## 1.0.5

### Patch Changes

- a936749: Drop Node.js <20 support (Node 18 is EOL).

  Note: WyW `1.0.0` already effectively required Node 20 in practice; this change makes the support policy explicit and
  aligns docs/CI accordingly.

  If DOM emulation is enabled (`features.happyDOM`), but `happy-dom` cannot be loaded via `require()` (ESM-only), WyW will
  fall back to running without DOM and print a one-time warning with guidance.

- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.5
  - @wyw-in-js/webpack-loader@1.0.5

## 1.0.4

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.4
  - @wyw-in-js/webpack-loader@1.0.4

## 1.0.3

### Patch Changes

- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.3
  - @wyw-in-js/webpack-loader@1.0.3

## 1.0.2

### Patch Changes

- Bump versions
- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.2
  - @wyw-in-js/webpack-loader@1.0.2

## 1.0.1

### Patch Changes

- 5882514: Fix publishing so released packages don't contain `workspace:*` dependency ranges (npm install compatibility).
- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.1
  - @wyw-in-js/webpack-loader@1.0.1

## 1.0.0

### Major Changes

- 94c5efa: Release **1.0.0** introduces no breaking changes compared to previous releases.

  This release establishes a stable baseline for future development, including upcoming releases focused on performance
  and build-time optimizations.

### Minor Changes

- 0b87b81: Add official Next.js integration via `withWyw()` and make `@wyw-in-js/webpack-loader` compatible with Next.js CSS extraction.
- 4cf8447: Add Turbopack support for Next.js via `turbopack.rules` and introduce `@wyw-in-js/turbopack-loader`.

### Patch Changes

- 16a64ad: Document the `prefixer: false` option to disable vendor prefixing in bundler plugins.
- Updated dependencies
  - @wyw-in-js/turbopack-loader@1.0.0
  - @wyw-in-js/webpack-loader@1.0.0
