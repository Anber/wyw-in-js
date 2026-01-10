# @wyw-in-js/transform

## 1.0.2

### Patch Changes

- Bump versions
- Updated dependencies
  - @wyw-in-js/processor-utils@1.0.2
  - @wyw-in-js/shared@1.0.2

## 1.0.1

### Patch Changes

- 5882514: Fix publishing so released packages don't contain `workspace:*` dependency ranges (npm install compatibility).
- Updated dependencies
  - @wyw-in-js/processor-utils@1.0.1
  - @wyw-in-js/shared@1.0.1

## 1.0.0

### Major Changes

- 94c5efa: Release **1.0.0** introduces no breaking changes compared to previous releases.

  This release establishes a stable baseline for future development, including upcoming releases focused on performance
  and build-time optimizations.

### Minor Changes

- 62fef83: Fix shaker keeping unused imports in eval bundles (named/namespace/side-effect imports), which could trigger build-time evaluation crashes (e.g. `@radix-ui/react-tooltip`).

  `@wyw-in-js/shared` now passes `importOverrides`/`root` through the evaluator config so the shaker can keep or mock side-effect imports when configured.

  Note: eval bundles for `__wywPreval` now drop `import '...';` side-effect imports by default, to avoid executing unrelated runtime code in Node.js during build. If you rely on a side-effect import at eval time, keep it or stub it via `importOverrides`:

  - `{ noShake: true }` to keep the import (and disable tree-shaking for that dependency).
  - `{ mock: './path/to/mock' }` to redirect the import to a mock module.

### Patch Changes

- 7144b0c: Fix Babel TypeScript transform crashing on `declare` class fields by ensuring `allowDeclareFields` is enabled when using the TypeScript preset/plugin.
- 0477b30: Fix export detection for array destructuring declarations (e.g. `export const [B] = ...`).
- fad6207: Fix config merging with `@babel/core@7.25.7` by avoiding `babel-merge`'s `resolvePreset` regression.
- c26b337: Bump `happy-dom` dependency to `^20.1.0`.
- 485fd7d: Preserve cached exports when evaluating only missing imports to avoid re-running unused code.
- 83d8915: Normalize multi-keyword `display` values (e.g. `flex inline`) before Stylis prefixing to avoid malformed CSS output.
- 265a8d7: Fix `evaluate: true` export caching so additional export requests don’t combine exports from different module executions.
- 9715eee: Fix `export * from` being dropped when the reexport target is ignored (e.g. via `extensions`).
- 45ef60a: Fix missing CSS emission for tags inside named function expressions (e.g. `export const a = function a() { return css\`\`; }`).
- 908968b: Avoid emitting `/*#__PURE__*/` on non-call/new expressions to prevent Rollup warnings during builds.
- d2f5472: Fix shaker removing referenced bindings when dropping unused exports (e.g. object shorthand `{ fallback }`).
- 06e80fb: Fix stale imported object exports during incremental rebuilds when `features.globalCache` is enabled.
- c024a34: Avoid repeated evaluator re-runs for large, statically evaluatable modules by promoting them to wildcard `only` on first entrypoint creation.
- fcb118a: Add a `keepComments` option for the stylis preprocessor to preserve selected CSS comments.
- 64b7698: Prevent concurrent transforms from reusing cached actions with different handler instances by stabilizing resolvers across bundlers.
- d4cefc9: Avoid leaving empty Promise callbacks when dangerous globals are removed.
- 485fd7d: fix: drop unused imports when named and default exports share a binding
- ac44dcc: Avoid retaining unused import specifiers during shaking so eval doesn't load unrelated deps.
- 782e67f: Drop property assignments on shaken exports so eval doesn't touch Storybook globals.
- 870b07b: Handle unknown/dynamic import specifiers without transform-time crashes, add `importOverrides` (mock/noShake/unknown policy), and emit a deduped warning only when eval reaches Node resolver fallback (bundler-native where possible).
- 26ec4a3: Fix handling of import resource queries (e.g. `?raw`, `?url`) to avoid crashes and allow minimal eval-time loaders.
- 2a8ab79: Extend `tagResolver` with a third `meta` argument (`sourceFile`, `resolvedSource`) so custom tag processors can be resolved reliably.
- 4c268ad: Support Vite's `import.meta.env.*` during build-time evaluation.
- Updated dependencies
  - @wyw-in-js/processor-utils@1.0.0
  - @wyw-in-js/shared@1.0.0

## 0.8.1

### Patch Changes

- 691f946: Handle Vite virtual modules like `/@react-refresh` without filesystem lookups to prevent ENOENT in dev.
- b33ed9c: fix(transform): guard cache entries missing initialCode (#144)
- fcfdf52: Avoid infinite recursion when encountering import cycles while invalidating the cache.
- Updated dependencies [7321fd3]
- Updated dependencies [fcfdf52]
  - @wyw-in-js/processor-utils@0.8.1
  - @wyw-in-js/shared@0.8.1

## 0.8.0

### Minor Changes

- 4212218: chore: bump happy-dom to 20.0.10

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@0.8.0
  - @wyw-in-js/processor-utils@0.8.0

## 0.7.0

### Minor Changes

- 168341b: New option `prefixer` that allows disabling the built-in CSS-prefixed.
- 58da575: Ensure cache invalidates correctly when dependency content changes.

### Patch Changes

- Updated dependencies
- Updated dependencies [58da575]
  - @wyw-in-js/processor-utils@0.7.0
  - @wyw-in-js/shared@0.7.0

## 0.6.0

### Minor Changes

- 4c0071d: Configurable code remover can detect and remove from evaluation HOCs and components with specific explicit types.

### Patch Changes

- fc07b6b: The check for unsupported dynamic imports has been moved to the evaluation stage. We don't want to fail if this import is unreachable during evaluation. Fixes #126.
- Updated dependencies [4c0071d]
  - @wyw-in-js/shared@0.6.0
  - @wyw-in-js/processor-utils@0.6.0

## 0.5.5

### Patch Changes

- 830d6df: chore: bump happy-dom to 13.10.1
- fcfc357: chore: bump happy-dom to 14.12.3
- 81bcb65: chore: bump happy-dom to 15.11.0
- Updated dependencies [6bd612a]
  - @wyw-in-js/shared@0.5.5
  - @wyw-in-js/processor-utils@0.5.5

## 0.5.4

### Patch Changes

- 3cadae5: Support for @media selectors inside :global selectors.
- Updated dependencies
  - @wyw-in-js/shared@0.5.4
  - @wyw-in-js/processor-utils@0.5.4

## 0.5.3

### Patch Changes

- 21f175c: Pass `extensions` option to processors
- Updated dependencies [21f175c]
- Updated dependencies
  - @wyw-in-js/processor-utils@0.5.3
  - @wyw-in-js/shared@0.5.3

## 0.5.2

### Patch Changes

- Updated dependencies
- Updated dependencies [9096ba1]
  - @wyw-in-js/shared@0.5.2
  - @wyw-in-js/processor-utils@0.5.2

## 0.5.1

### Patch Changes

- cd7b7f0: Allow conditional usage of WeakRef in Module evalutation through a new feature flag `useWeakRefInEval`
- Updated dependencies
  - @wyw-in-js/shared@0.5.1
  - @wyw-in-js/processor-utils@0.5.1

## 0.5.0

### Minor Changes

- Bump versions

### Patch Changes

- 9d7cb05: Fix an issue when some animation names are not suffixed.
- Updated dependencies [aa1ca75]
  - @wyw-in-js/processor-utils@0.5.0
  - @wyw-in-js/shared@0.5.0

## 0.4.1

### Patch Changes

- 399d5b4: Optimised processing. Up to 2 times faster detection of template literals.
- 3a494ef: Found out that an object spread can be extremely slow. getTagProcessor now works 10 times faster.
- Updated dependencies
  - @wyw-in-js/shared@0.4.1
  - @wyw-in-js/processor-utils@0.4.1

## 0.4.0

### Minor Changes

- 8eca477: Keyframes are now scoped by default. This behaviour can be changed by `:global()`: `@keyframes :global(bar) {…}`, `animation-name: :global(bar);`.

### Patch Changes

- edf8c81: Fix support of :global() selector in nested rules (fixes #42)
- Updated dependencies [c1a83e4]
- Updated dependencies
- Updated dependencies [0af626b]
  - @wyw-in-js/shared@0.4.0
  - @wyw-in-js/processor-utils@0.4.0

## 0.3.0

### Minor Changes

- e2c567a: Export findIdentifiers in main index file

### Patch Changes

- Updated dependencies
  - @wyw-in-js/shared@0.3.0
  - @wyw-in-js/processor-utils@0.3.0

## 0.2.3

### Patch Changes

- ec051b7: feat: add stylis plugin to handle ":global()"
- 769653f: Sometimes, usages of variables survive the shaker even when their bindings are removed. Fixed.
- Updated dependencies
  - @wyw-in-js/shared@0.2.3
  - @wyw-in-js/processor-utils@0.2.3

## 0.2.2

### Patch Changes

- e1701d5: Fix the regression from callstack/linaria#1373 that messed up with namespaces in CSS.
- 740e336: Fix regression from #19 that kills some exports.
- a8e5da0: Improved shaker strategy for exports fixes some of `undefined` errors.
- Updated dependencies
  - @wyw-in-js/shared@0.2.2
  - @wyw-in-js/processor-utils@0.2.2

## 0.2.1

### Patch Changes

- Bump versions
- Updated dependencies
  - @wyw-in-js/shared@0.2.1
  - @wyw-in-js/processor-utils@0.2.1

## 0.2.0

### Minor Changes

- ca5c2e7: All Linaria-related things were renamed.

### Patch Changes

- 4b869aa: Fixtures generator and enhanced support of different transpilers.
- Updated dependencies [ca5c2e7]
  - @wyw-in-js/processor-utils@0.2.0
  - @wyw-in-js/shared@0.2.0

## 0.1.1

### Patch Changes

- 6f8ae08: Plugin for Rollup.
- Updated dependencies
  - @wyw-in-js/shared@0.1.1
  - @wyw-in-js/processor-utils@0.1.1

## 0.1.0

### Minor Changes

- 02973e1: `@linaria/webpack5-loader` has been moved and renamed into `@wyw-in-js/webpack-loader`. Support for Webpack 4 has been dropped.
- e02d5d2: `@linaria/babel-preset` and `@linaria/shaker` have been merged into `@wyw-in-js/transform`.

### Patch Changes

- Updated dependencies [e02d5d2]
  - @wyw-in-js/processor-utils@0.1.0
  - @wyw-in-js/shared@0.1.0
