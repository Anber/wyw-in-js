# @wyw-in-js/transform

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
