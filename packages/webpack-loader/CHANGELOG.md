# @wyw-in-js/webpack-loader

## 1.0.5

### Patch Changes

- a936749: Drop Node.js <20 support (Node 18 is EOL).

  Note: WyW `1.0.0` already effectively required Node 20 in practice; this change makes the support policy explicit and
  aligns docs/CI accordingly.

  If DOM emulation is enabled (`features.happyDOM`), but `happy-dom` cannot be loaded via `require()` (ESM-only), WyW will
  fall back to running without DOM and print a one-time warning with guidance.

- Updated dependencies
  - @wyw-in-js/shared@1.0.4
  - @wyw-in-js/transform@1.0.5

## 1.0.4

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@1.0.3
  - @wyw-in-js/transform@1.0.4

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

- 0b87b81: Add official Next.js integration via `withWyw()` and make `@wyw-in-js/webpack-loader` compatible with Next.js CSS extraction.
- 16a64ad: Document the `prefixer: false` option to disable vendor prefixing in bundler plugins.
- 63c4d7e: Fix Rsbuild/Rspack dev HMR where extracted CSS updates could apply one edit behind.
- 790e73b: Fix `cacheProvider` object instances so extracted CSS is read from the same cache instance by the internal output loader.
- fcb118a: Add a `keepComments` option for the stylis preprocessor to preserve selected CSS comments.
- 64b7698: Prevent concurrent transforms from reusing cached actions with different handler instances by stabilizing resolvers across bundlers.
- 870b07b: Handle unknown/dynamic import specifiers without transform-time crashes, add `importOverrides` (mock/noShake/unknown policy), and emit a deduped warning only when eval reaches Node resolver fallback (bundler-native where possible).
- 26ec4a3: Fix handling of import resource queries (e.g. `?raw`, `?url`) to avoid crashes and allow minimal eval-time loaders.
- Updated dependencies
  - @wyw-in-js/shared@1.0.0
  - @wyw-in-js/transform@1.0.0

## 0.8.1

### Patch Changes

- fcfdf52: Avoid infinite recursion when encountering import cycles while invalidating the cache.
- Updated dependencies [691f946]
- Updated dependencies [b33ed9c]
- Updated dependencies [fcfdf52]
  - @wyw-in-js/transform@0.8.1
  - @wyw-in-js/shared@0.8.1

## 0.8.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies [4212218]
- Updated dependencies
  - @wyw-in-js/transform@0.8.0
  - @wyw-in-js/shared@0.8.0

## 0.7.0

### Minor Changes

- 168341b: New option `prefixer` that allows disabling the built-in CSS-prefixed.
- 58da575: Ensure cache invalidates correctly when dependency content changes.

### Patch Changes

- Updated dependencies [168341b]
- Updated dependencies [58da575]
  - @wyw-in-js/transform@0.7.0
  - @wyw-in-js/shared@0.7.0

## 0.6.0

### Minor Changes

- 4c0071d: Configurable code remover can detect and remove from evaluation HOCs and components with specific explicit types.

### Patch Changes

- Updated dependencies [4c0071d]
- Updated dependencies [fc07b6b]
  - @wyw-in-js/transform@0.6.0
  - @wyw-in-js/shared@0.6.0

## 0.5.5

### Patch Changes

- Updated dependencies [6bd612a]
- Updated dependencies [830d6df]
- Updated dependencies [fcfc357]
- Updated dependencies [81bcb65]
  - @wyw-in-js/shared@0.5.5
  - @wyw-in-js/transform@0.5.5

## 0.5.4

### Patch Changes

- Updated dependencies [3cadae5]
- Updated dependencies
  - @wyw-in-js/transform@0.5.4
  - @wyw-in-js/shared@0.5.4

## 0.5.3

### Patch Changes

- Updated dependencies [21f175c]
- Updated dependencies
  - @wyw-in-js/transform@0.5.3
  - @wyw-in-js/shared@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@0.5.2
  - @wyw-in-js/transform@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies
- Updated dependencies [cd7b7f0]
  - @wyw-in-js/shared@0.5.1
  - @wyw-in-js/transform@0.5.1

## 0.5.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies [aa1ca75]
- Updated dependencies [9d7cb05]
- Updated dependencies
  - @wyw-in-js/shared@0.5.0
  - @wyw-in-js/transform@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies
- Updated dependencies [399d5b4]
- Updated dependencies [3a494ef]
  - @wyw-in-js/shared@0.4.1
  - @wyw-in-js/transform@0.4.1

## 0.4.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies [edf8c81]
- Updated dependencies [c1a83e4]
- Updated dependencies
- Updated dependencies [8eca477]
- Updated dependencies [0af626b]
  - @wyw-in-js/transform@0.4.0
  - @wyw-in-js/shared@0.4.0

## 0.3.0

### Minor Changes

- Bump versions

### Patch Changes

- Updated dependencies
- Updated dependencies [e2c567a]
  - @wyw-in-js/shared@0.3.0
  - @wyw-in-js/transform@0.3.0

## 0.2.3

### Patch Changes

- b98eae3: feat: export LoaderOptions
- Updated dependencies
- Updated dependencies [ec051b7]
- Updated dependencies [769653f]
  - @wyw-in-js/shared@0.2.3
  - @wyw-in-js/transform@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies [e1701d5]
- Updated dependencies [740e336]
- Updated dependencies [a8e5da0]
  - @wyw-in-js/shared@0.2.2
  - @wyw-in-js/transform@0.2.2

## 0.2.1

### Patch Changes

- Bump versions
- Updated dependencies
  - @wyw-in-js/transform@0.2.1
  - @wyw-in-js/shared@0.2.1

## 0.2.0

### Minor Changes

- ca5c2e7: All Linaria-related things were renamed.

### Patch Changes

- e3b1583: docs: add README file
- Updated dependencies [4b869aa]
- Updated dependencies [ca5c2e7]
  - @wyw-in-js/transform@0.2.0
  - @wyw-in-js/shared@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [6f8ae08]
- Updated dependencies
  - @wyw-in-js/transform@0.1.1
  - @wyw-in-js/shared@0.1.1

## 0.1.0

### Minor Changes

- 02973e1: `@linaria/webpack5-loader` has been moved and renamed into `@wyw-in-js/webpack-loader`. Support for Webpack 4 has been dropped.

### Patch Changes

- Updated dependencies [02973e1]
- Updated dependencies [e02d5d2]
  - @wyw-in-js/transform@0.1.0
  - @wyw-in-js/shared@0.1.0
