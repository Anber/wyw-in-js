# Oxc Migration Recovery Plan

## What Went Wrong

The previous migration attempt took the wrong engineering path.

Instead of porting the existing Babel-backed implementation to Oxc, it introduced a simplified Oxc implementation and removed too much of the old behavioral surface. That included not only tests, but also production logic and internal seams that encoded years of edge-case handling.

This is not acceptable for this migration. The correct migration is not "build a new transform next to the old one and make new tests pass". The correct migration is "take the existing v2 Babel implementation as the behavior specification and port it to Oxc file by file".

## Non-Negotiable Direction

- Start from clean `v2`.
- Do not continue from the current broken migration state.
- Do not delete Babel-era logic just because it mentions Babel.
- Do not replace complex existing behavior with simplified Oxc-shaped guesses.
- Do not adjust tests to match incomplete Oxc behavior.
- Do not remove old regression tests unless the exact behavior is covered by an equivalent Oxc-based test.
- Do not remove fixtures just because their filenames or contents mention Babel; compiled fixture corpora may still encode important interoperability behavior.
- Do not remove public or internal seams until all call sites and regression tests prove the Oxc replacement is equivalent.
- Third-party dependencies may still contain Babel internally; the migration target is that WyW library code no longer uses Babel as its transform/evaluator/build engine.

## Reset Assumption

Before continuing implementation, the current branch should be restored to the clean `v2` state.

After that, re-apply only the parts that are still valid:

- Oxc-first public option contract.
- Resolver strategy contract, including opt-in hybrid behavior.
- Engine-neutral syntax/processor interfaces where they are needed to port existing code.
- Oxc build driver only if it preserves the existing package build behavior.

Everything else must be reintroduced by porting existing logic, not by recreating a reduced version.

## Migration Method

For every Babel-backed module:

1. Read the current `v2` file and identify its behavioral responsibilities.
2. Keep the existing tests and fixtures as the regression contract.
3. Port the implementation to Oxc while preserving function names, exported seams, metadata shape, and observable behavior where possible.
4. Only then remove the Babel dependency from that module.
5. Run the old tests unchanged first.
6. If a test must change, document the exact reason in the code review notes and preserve the same behavioral scenario.
7. Add new Oxc-specific tests only for new Oxc-specific behavior, not as replacements for missing old coverage.

## Processor Compatibility Strategy

Processor compatibility is a first-class migration requirement.

The first approach is to preserve the current processor authoring model by implementing the existing `AstService` contract on top of Oxc-backed expression/code generation primitives. Existing processors should keep working as much as possible without being rewritten from scratch.

This must be attempted before forcing processor authors onto a new API.

However, this has a hard limit: do not rebuild a broad Babel-compatible AST facade if that becomes disproportionate to the migration. If preserving the current `AstService` shape on Oxc requires a large fake Babel AST implementation or fragile partial emulation, stop and document the boundary.

If that limit is reached, propose an explicit backward-compatibility plan for processor implementations instead. That plan must include:

- which existing processor APIs remain source-compatible;
- which APIs require migration;
- whether compatibility adapters can wrap old processors;
- how existing Linaria/WyW processors are migrated;
- which tests prove old processor behavior still works;
- what the public migration path for custom processors is.

## Files And Areas That Must Be Ported, Not Removed

The following areas are known to contain important behavior and must be treated as source-of-truth logic:

- `packages/transform/src/plugins/preeval.ts`
- `packages/transform/src/plugins/shaker.ts`
- `packages/transform/src/plugins/collector.ts`
- `packages/transform/src/plugins/dynamic-import.ts`
- `packages/transform/src/plugins/require-fallback.ts`
- `packages/transform/src/utils/removeDangerousCode.ts`
- `packages/transform/src/utils/visitors/JSXElementsRemover.ts`
- `packages/transform/src/utils/collectTemplateDependencies.ts`
- `packages/transform/src/utils/collectExportsAndImports.ts`
- `packages/transform/src/utils/getTagProcessor.ts`
- `packages/transform/src/utils/scopeHelpers.ts`
- `packages/transform/src/utils/isGlobal.ts`
- `packages/transform/src/utils/isUnnecessaryReactCall.ts`
- `packages/transform/src/shaker.ts`
- `packages/transform/src/transform/preevalStage.ts`
- `packages/transform/src/transform/generators/*`
- `packages/processor-utils/src/*`
- bundled adapter integration points in esbuild, Vite, Webpack, Rollup, Next.js, Rspack, Parcel, Bun, and Turbopack packages.

## Tests And Fixtures That Must Remain As Regression Contract

The following test groups must be preserved or ported with equivalent behavioral coverage:

- `collectExportsAndImports` corpus, including ESM and compiled CommonJS fixture variants.
- `shaker.test.ts` and its snapshots.
- `preeval.test.ts` and its snapshots.
- `collectTemplateDependencies.test.ts` and its snapshots.
- `extractExpression.test.ts` and its snapshots.
- `isUnnecessaryReactCall.test.ts`.
- `dynamic-import-plugin.test.ts`.
- `getTagProcessor.*.test.ts`.
- adapter tests that currently exercise pre-transform configuration behavior.
- example processor tests in object syntax and template tag syntax examples.

Deleting these tests is only allowed after the same scenarios are covered by Oxc-based tests that fail against incomplete behavior.

## Porting Order

1. Reset to `v2` and verify the baseline is clean.
2. Reintroduce Oxc config contract and resolver contract without changing runtime behavior.
3. Add engine-neutral syntax and processor types as a seam, not as a replacement implementation.
4. Port parsing and module analysis from `collectExportsAndImports` behavior to Oxc.
5. Port dynamic import and require fallback transformations.
6. Port `removeDangerousCode` and `JSXElementsRemover` heuristics.
7. Port preeval stage while preserving existing plugin guard behavior and metadata.
8. Port template dependency extraction and expression hoisting.
9. Port tag processor discovery/application without weakening processor compatibility.
10. Port shaker behavior, including import metadata, side-effect handling, reexports, CommonJS emit, TypeScript syntax stripping, and `onlyExports` semantics.
11. Port collect/runtime replacement/output emission with source map parity.
12. Convert the Babel preset package into a compatibility wrapper only after the core Oxc path is equivalent.
13. Replace package build usage of Babel only after runtime transform parity is proven.
14. Remove remaining first-party Babel usage only after all old and new regression suites pass.

## Acceptance Criteria

- Clean `v2` baseline is the starting point.
- Existing behavior remains covered by old tests or exact Oxc-equivalent tests.
- Core transform/evaluator path no longer uses Babel.
- Processor APIs are engine-neutral and downstream processors can compile without Babel types.
- Existing evaluator architecture remains intact: async ESM evaluator, broker, lazy prepare/load, cache invalidation, import overrides, and adapter resolution behavior.
- No `.babelrc`, `babelOptions`, Babel parser, Babel traverse, Babel generator, or Babel transform dependency remains in first-party library runtime/build paths after final cutover.
- Package builds no longer depend on Babel CLI after build migration is completed.
- Public docs describe the Oxc-first contract, while compatibility wrapper behavior is clearly scoped.
- Full local validation and targeted package test/typecheck runs pass before the migration is considered complete.

## Explicit Anti-Patterns To Avoid

- Building an Oxc implementation beside the old Babel implementation and deleting the old one later without parity.
- Creating narrow tests that only prove the new implementation's current behavior.
- Removing fixtures because they are inconvenient to port.
- Treating green targeted tests as proof of migration completeness when old regression suites were removed or bypassed.
- Removing public package compatibility before downstream processors are migrated.
- Chasing zero Babel strings in lockfiles or third-party packages instead of removing first-party Babel usage.

## Current Lesson

The old Babel implementation is not disposable scaffolding. It is the current behavior specification.

The migration must preserve that behavior and change the engine underneath it.

## Progress

- Baseline/foundation/runtime: branch was reset to clean `v2`, then valid Oxc foundation was reapplied. Oxc now covers config/resolver seams, module analysis, preeval heuristics, processor application through narrow `AstService`, shaker, collect/emit, barrel optimization, eval broker/runner, lazy loading, cache invalidation, and sourcemap-bearing emit in the focused parity suites.
- Build path: all package `build:esm` scripts use the shared Oxc build driver instead of package-local Babel CLI config. Clean package ESM/types rebuilds pass via local Turbo `--no-daemon --force`; generated package output has no Babel runtime/build imports outside the compatibility preset.
- Processor BC/reference: first-party/example/Linaria processor usage fits the narrow Oxc-backed `AstService`; no broad fake Babel AST facade has been introduced. Legacy Babel implementation files were moved out of production `src` into `src/__tests__/legacy-babel-reference`, so old regression tests still execute but library source/build no longer carries Babel implementation modules.
- Public cleanup: active shared/transform/adapter APIs no longer expose `babelOptions`, `useBabelConfigs`, `babelTransform`, `Services.babel`, or `SyntaxEngine: 'babel'`. Next adapter no longer injects `next/babel`; its only remaining Babel strings are Next loader names used to identify existing transpile rules.
- Docs/release text: public website config/bundler docs and changesets now describe Oxc-first options, `@wyw-in-js/babel-preset` as compatibility wrapper, and removal of core Babel config/service contracts. The `useBabelConfigs` feature page was removed.
- Latest fixes/checks: fixed collect-time cleanup so processor-consumed imports/helpers are removed through the same closure pass, restored export-star leaf invalidation by hashing `exports` cache entries too, and kept runtime normalization closer to Babel output (`/* @flow */` spacing, no extra `;` after exported function declarations). Full `@wyw-in-js/transform` suite now passes (`504 pass`). All package `build:esm`/`build:types` tasks pass via local Turbo `--no-daemon --force`; all package tests pass. Transform lint passes with warnings only.
- Processor examples and first-party config cleanup: object/template syntax examples no longer carry Babel CLI/config/devDeps; their processors remain on the narrow `AstService` contract. The now-unused private `@wyw-in-js/babel-config` workspace was removed. Oxc `build:esm`, `build:types`, and existing applyProcessors tests pass for both processor examples.
- Dependency footprint/audit: `@wyw-in-js/transform` package manifest no longer carries Babel devDeps; legacy-reference tests resolve Babel from root test-only devDeps. Generated package `esm/types` audit has no Babel runtime/build imports outside `@wyw-in-js/babel-preset`; Next adapter keeps only loader-name detection strings.
- Current parity slice: downstream Linaria now runs on the Oxc path without the earlier loader/classname/reexport crashes. Recent fixes aligned root fallback for slug generation, made native `oxc-transform` loading Jest-safe, restored per-owner hoist insertion, narrowed cleanup from blanket unused-DCE to processor/dependency chains, and removed top-level expression tails that only referenced processor outputs. Focused transform/processor-utils suites stay green after each step.
- Latest parity closure: boxed-primitive IPC, static string `require(...)` inlining, collect-time cleanup chains, runtime object formatting, and extractor static-eval for shadowed locals/helper calls/object mutations are now covered by direct Oxc tests. Focused Linaria regression subsets for shadowed identifiers, helper calls, object-mutation components, and nested object interpolation are green again on the Oxc path.
- Latest parity closure: root dependency metadata no longer leaks synthetic leaf imports created by Oxc barrel rewrite; focused Linaria reexport/circular/wildcard subsets are fully green again, including renamed-import exports and concurrent reexport chains.
- Latest parity closure: downstream CJS/transpiled-React simplification, helper-cleanup closure, display-name codeframe path, Istanbul sequence stripping, and `evaluatedOnly='*'` cache promotion are restored on the Oxc path; focused Linaria subsets for those cases are now green.
- Consumer cutover: Linaria downstream tests/fixtures were moved off implicit Babel compat. `packages/testkit` now uses the Oxc-first WyW contract, old `.babelrc`/`useBabelConfigs`/`babelOptions` expectations were replaced with explicit filename semantics and explicit WyW `configFile` / `eval.customResolver` coverage, and the fixture now uses `wyw-in-js.config.cjs` instead of Babel config.
- Downstream validation: after the consumer-side cutover, full `@linaria/testkit` is green on the Oxc path. Remaining differences in that consumer were accepted as Oxc-first snapshot baselines rather than hidden runtime failures; current noise is limited to existing eval fallback warnings during tests, not red assertions.
- Latest validate closure: Darkmatter export-surface crashes on shared modules (`Icons.ts`, then `Input.tsx`) were traced to evaluator module reuse and root `Entrypoint` widening. Fixes landed in the eval runner load de-dup key plus `Entrypoint` root supersede behavior, with regression coverage in `eval-broker.test.ts` and `transform/__tests__/createEntrypoint.test.ts`.
- Validation gate status: full `./validate.sh` is green again on this branch, including WyW package builds, Darkmatter build/CSS compare, Linaria build/tests, and Portal package/app builds. Temporary Darkmatter/Input trace scaffolding used during triage was removed after the fix was verified.
