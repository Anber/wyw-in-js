# @wyw-in-js/transform

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
