# @wyw-in-js/shared

## 1.0.0

### Major Changes

- 94c5efa: Release **1.0.0** introduces no breaking changes compared to previous releases.

  This release establishes a stable baseline for future development, including upcoming releases focused on performance
  and build-time optimizations.

### Patch Changes

- 62fef83: Fix shaker keeping unused imports in eval bundles (named/namespace/side-effect imports), which could trigger build-time evaluation crashes (e.g. `@radix-ui/react-tooltip`).

  `@wyw-in-js/shared` now passes `importOverrides`/`root` through the evaluator config so the shaker can keep or mock side-effect imports when configured.

  Note: eval bundles for `__wywPreval` now drop `import '...';` side-effect imports by default, to avoid executing unrelated runtime code in Node.js during build. If you rely on a side-effect import at eval time, keep it or stub it via `importOverrides`:

  - `{ noShake: true }` to keep the import (and disable tree-shaking for that dependency).
  - `{ mock: './path/to/mock' }` to redirect the import to a mock module.

- 61fb173: Fix TypeScript consumer builds by shipping `@types/debug` as a dependency (public `.d.ts` imports `debug`).
- 64b7698: Prevent concurrent transforms from reusing cached actions with different handler instances by stabilizing resolvers across bundlers.
- 870b07b: Handle unknown/dynamic import specifiers without transform-time crashes, add `importOverrides` (mock/noShake/unknown policy), and emit a deduped warning only when eval reaches Node resolver fallback (bundler-native where possible).
- 2a8ab79: Extend `tagResolver` with a third `meta` argument (`sourceFile`, `resolvedSource`) so custom tag processors can be resolved reliably.

## 0.8.1

### Patch Changes

- fcfdf52: Avoid infinite recursion when encountering import cycles while invalidating the cache.

## 0.8.0

### Minor Changes

- Bump versions

## 0.7.0

### Minor Changes

- 58da575: Ensure cache invalidates correctly when dependency content changes.

## 0.6.0

### Minor Changes

- 4c0071d: Configurable code remover can detect and remove from evaluation HOCs and components with specific explicit types.

## 0.5.5

### Patch Changes

- 6bd612a: fix(shared): invalid export of interface

## 0.5.4

### Patch Changes

- Bump versions

## 0.5.3

### Patch Changes

- Bump versions

## 0.5.2

### Patch Changes

- Bump versions

## 0.5.1

### Patch Changes

- Bump versions

## 0.5.0

### Minor Changes

- aa1ca75: Add `index` to ClassNameSlugVars

## 0.4.1

### Patch Changes

- Bump versions

## 0.4.0

### Minor Changes

- Bump versions

### Patch Changes

- c1a83e4: Fix crash while resolving esm-only package. Fixes #43
- 0af626b: Removed `<reference types="node" />` from `@wyw-in-js/shared`. Fixes #33.

## 0.3.0

### Minor Changes

- Bump versions

## 0.2.3

### Patch Changes

- Bump versions

## 0.2.2

### Patch Changes

- Bump versions

## 0.2.1

### Patch Changes

- Bump versions

## 0.2.0

### Minor Changes

- ca5c2e7: All Linaria-related things were renamed.

## 0.1.1

### Patch Changes

- Bump versions

## 0.1.0

### Minor Changes

- e02d5d2: `@linaria/babel-preset` and `@linaria/shaker` have been merged into `@wyw-in-js/transform`.
