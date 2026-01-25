# @wyw-in-js/vite

## 1.0.6

### Patch Changes

- Updated dependencies
  - @wyw-in-js/transform@1.0.6

## 1.0.5

### Patch Changes

- 3dec017: Fix cache invalidation storms when loader-provided code differs from filesystem code, keep the Vite resolver stable across repeated `configResolved` calls, and avoid eagerly walking dynamic import targets during eval-only runs (prevents `action handler is already set` and improves build performance on large projects).
- a936749: Drop Node.js <20 support (Node 18 is EOL).

  Note: WyW `1.0.0` already effectively required Node 20 in practice; this change makes the support policy explicit and
  aligns docs/CI accordingly.

  If DOM emulation is enabled (`features.happyDOM`), but `happy-dom` cannot be loaded via `require()` (ESM-only), WyW will
  fall back to running without DOM and print a one-time warning with guidance.

- 9e08238: Fix cache invalidation when a file is first read from the filesystem and later provided by a bundler/loader, preventing stale transforms and related Vite build/dev issues.
- ed6a3e6: Fix a Vite dev error ("action handler is already set") by isolating WyW transform cache per plugin context.
- Updated dependencies
  - @wyw-in-js/shared@1.0.4
  - @wyw-in-js/transform@1.0.5

## 1.0.4

### Patch Changes

- b3bc127: Fix async module resolution by calling the bundler `resolve()` with the correct plugin context.
- Updated dependencies
  - @wyw-in-js/shared@1.0.3
  - @wyw-in-js/transform@1.0.4

## 1.0.3

### Patch Changes

- adbd48c: Avoid falling back to Node resolution for Vite `external` resolved file ids (incl. `external: "absolute"`), which could break aliased imports during build-time evaluation (SSR/dev).
- Updated dependencies
  - @wyw-in-js/transform@1.0.3

## 1.0.2

### Patch Changes

- 30121b1: Handle Vite `/@fs/` resolved ids so alias imports resolve during eval instead of falling back to Node.
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

- 08475ce: Add an opt-in `ssrDevCss` mode to avoid SSR dev FOUC by serving aggregated CSS and injecting a stylesheet link in transformed HTML.
- 16a64ad: Document the `prefixer: false` option to disable vendor prefixing in bundler plugins.
- fcb118a: Add a `keepComments` option for the stylis preprocessor to preserve selected CSS comments.
- 64b7698: Prevent concurrent transforms from reusing cached actions with different handler instances by stabilizing resolvers across bundlers.
- 870b07b: Handle unknown/dynamic import specifiers without transform-time crashes, add `importOverrides` (mock/noShake/unknown policy), and emit a deduped warning only when eval reaches Node resolver fallback (bundler-native where possible).
- ae740bf: Add `transformLibraries` option to allow transforming selected dependencies inside `node_modules` (opt-in; still recommended to narrow via filters).
- f8744ad: Avoid manually calling `optimizeDeps()` from the plugin resolve path when Vite returns a missing optimized-deps entry. This prevents Vite 7 deprecation spam and reduces dev server startup overhead.
- a5302b2: Defer reloading generated `*.wyw-in-js.css` modules to avoid Vite dev-server soft-invalidation errors.
- 4c268ad: Support Vite's `import.meta.env.*` during build-time evaluation.
- bd93f67: Add `preserveCssPaths` option to keep directory structure for generated `*.wyw-in-js.css` assets when using Rollup `preserveModules`.
- Updated dependencies
  - @wyw-in-js/shared@1.0.0
  - @wyw-in-js/transform@1.0.0

## 0.8.1

### Patch Changes

- 691f946: Handle Vite virtual modules like `/@react-refresh` without filesystem lookups to prevent ENOENT in dev.
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

- ee9e680: Fix CSS updation during Vite HMR where the new change wouldn't get correctly applied
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

- cdb2578: fix: handle cases when transforms don't generate CSS
- Updated dependencies
- Updated dependencies [ec051b7]
- Updated dependencies [769653f]
  - @wyw-in-js/shared@0.2.3
  - @wyw-in-js/transform@0.2.3

## 0.2.2

### Patch Changes

- 740e336: Fix regression from #19 that kills some exports.
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

- 334833c: Plugin for Vite.
- 6166aa6: Plugin for esbuild.
- Updated dependencies [6f8ae08]
- Updated dependencies
  - @wyw-in-js/transform@0.1.1
  - @wyw-in-js/shared@0.1.1
