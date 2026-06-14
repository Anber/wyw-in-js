# @wyw-in-js/transform

## 2.0.0

### Major Changes

- 2524aa4: Release WyW-in-JS v2.

  The v2 release moves the published packages to an ESM-only, Oxc-backed transform and evaluation pipeline and requires Node.js >= 22.0.0.

  Breaking changes and migration notes from v1:

  - CommonJS package entrypoints were removed. Migrate configs and tooling to ESM (`import()` / `.mjs`).
  - The transform path now uses Oxc for parsing, analysis, pre-evaluation rewrites, shaking, collection, and code generation. `@wyw-in-js/babel-preset` remains available as a deprecated compatibility wrapper around the Oxc pipeline.
  - Build-time evaluation now runs through the async ESM evaluator (`vm.SourceTextModule` + runner RPC).
  - The default value resolver is `eval.strategy: "hybrid"`: WyW tries static-first resolution for provable values and falls back to evaluator execution for values that still need runtime module evaluation. Use `eval.strategy: "execute"` for evaluator-only compatibility, or `eval.strategy: "static"` to reject evaluator fallback.
  - The previous top-level `evaluate` option is replaced by `eval.strategy`.
  - Eval IPC and config handling are stricter: unsupported `__wywPreval`, `eval.globals`, and inline non-serializable preset/plugin options now fail with explicit migration errors instead of being silently coerced.
  - `require()` inside eval follows the configured `eval.require` fallback behavior (`warn-and-run`, `error`, or `off`).
  - CSS rule emission order can differ from v1 for equivalent extracted rule sets because the static-first/Oxc pipeline can process preserved imports and rules in a different order. Projects that rely on cascade ties between generated rules should make precedence explicit in selector specificity, composition, or source structure.

  Migration guide: https://wyw-in-js.dev/migration/v2

### Minor Changes

- 2524aa4: Add native Oxc-backed import resolution for build-time evaluation.

  Hybrid eval resolution now tries a custom resolver first, then native resolution, then the bundler resolver. Native resolution is powered by `oxc-resolver`, discovers `tsconfig.json` by default, and receives static string aliases from Vite, esbuild, webpack, and Next Turbopack integrations while preserving explicitly configured `oxcOptions.resolver.alias` entries.

- 2524aa4: Expose the public Oxc configuration surface used by the v2 transform path.

  This introduces `oxcOptions` and per-rule `EvalRule.oxcOptions` so projects and bundler integrations can configure parser, transform, and resolver behavior for the Oxc-backed pipeline.

- 2524aa4: Add a supported processor diagnostics API that lets library-owned processors emit structured non-fatal warnings through WyW.

  This adds:

  - `BaseProcessor.addDiagnostic()` and typed diagnostics helpers in `@wyw-in-js/processor-utils`
  - normalized `diagnostics` output from `@wyw-in-js/transform`
  - diagnostics reporting in `@wyw-in-js/vite` and `@wyw-in-js/cli`

  Existing hard failures and metadata sidecar behavior stay intact.

- 2524aa4: Enable static-first value resolution by default with `eval.strategy: "hybrid"`.

  WyW can now resolve many imported literals, fixed objects, compiled TypeScript enum objects, zero-argument helper returns, compound component aliases, processor metadata values, and static metadata helper chains without starting the evaluator or loading the full module graph.

  The default `hybrid` mode keeps evaluator fallback for values that are not statically provable. Use `eval.strategy: "execute"` for evaluator-only compatibility and `eval.strategy: "static"` to reject fallback.

  Add `staticBindings` config for declaring additional statically-known imported values and pure helper functions.

- 2524aa4: Add an optional processor static evaluation contract. Processors can now describe statically known values as serializable values, class names, selector chains, runtime callbacks, opaque components, or unresolved values with reasons.

  The transform static evaluator now consumes this contract before falling back to legacy eval-time replacement metadata, so processors can provide their own static semantics without relying on transform-specific metadata shapes.

- 2524aa4: Add opt-in metadata manifest output across `@wyw-in-js/shared`, `@wyw-in-js/transform`, `@wyw-in-js/vite`, and `@wyw-in-js/cli`.

  When `outputMetadata` is enabled:

  - `@wyw-in-js/transform` now returns normalized, public metadata alongside the existing transform result.
  - `@wyw-in-js/vite` emits `.wyw-in-js.json` sidecar assets during build.
  - `@wyw-in-js/cli` writes matching `.wyw-in-js.json` sidecar files and supports an `--output-metadata` flag.

  This keeps default JS/CSS output unchanged while exposing stable metadata artifacts for CLI, Vite, and transform consumers.

### Patch Changes

- 2524aa4: Add optional JSONL debug output for evaluator payloads and transform perf spans.

  `eval-files.jsonl` records shipped evaluator code and serialized or stringified value details. `perf-spans.jsonl` records transform perf spans so evaluator and transform costs can be analyzed alongside action, dependency, and entrypoint logs.

- 2524aa4: Improve evaluator diagnostics and recovery for transient missing imports.

  Missing imports during evaluation now report the importing file, requested specifier, resolved path, and original error cause. The evaluator also evicts modules left in failed VM states and refreshes broker-side load tracking, so a subsequent evaluation can recover after the missing file is created instead of rethrowing stale module status errors.

- 2524aa4: Stabilize the v2 Oxc-backed transform and evaluator path for v1-compatible output.

  This covers import/order preservation, export shaking, CommonJS and live-binding emit, runtime source map composition, processor-added imports, hoisted template dependencies, React wrapper handling, Node 22 parse compatibility, dependency graph cache invalidation, and hot-path parse/cache performance.

- Updated dependencies
  - @wyw-in-js/processor-utils@2.0.0
  - @wyw-in-js/shared@2.0.0

## 2.0.0-alpha.2

### Patch Changes

- ccaf03e: Improve transform performance by caching OXC visitor keys, reusing cleanup parses, bypassing disabled emitter instrumentation, and updating OXC packages.

## 2.0.0-alpha.1

### Minor Changes

- 4fce392: Rename the eval resolver mode from `node` to `native` and resolve native eval imports with `oxc-resolver`. Hybrid eval resolution now tries the custom resolver, then native resolution, then the bundler resolver.

  Native eval resolution now discovers `tsconfig.json` by default. Vite, esbuild, webpack, and Next Turbopack integrations forward static string aliases from their bundler config into native resolver options, while preserving explicitly configured `oxcOptions.resolver.alias` entries.

- 0b44ada: Add an optional processor static evaluation contract. Processors can now describe statically known values as serializable values, class names, selector chains, runtime callbacks, opaque components, or unresolved values with reasons.

  The transform static evaluator now consumes this contract before falling back to legacy eval-time replacement metadata, so processors can provide their own static semantics without relying on transform-specific metadata shapes.

### Patch Changes

- 32cdb0b: Add optional eval payload debug JSONL output, including shipped code and serialized or stringified value details for log analysis.
- dc4e7f0: Improve evaluation diagnostics and recovery for transient missing imports.

  Missing imports during evaluation now report the importing file, requested specifier, resolved path, and original error cause. The evaluator also evicts modules left in failed VM states and refreshes broker-side load tracking, so a subsequent evaluation can recover after the missing file is created instead of rethrowing stale module status errors.

- df797cd: Lower explicit resource management syntax in ESM build output so the v2 package
  can be parsed on Node 22. The previous v2 alpha build left raw
  `using abortSignal` declarations in `@wyw-in-js/transform` ESM artifacts.
- a227252: Add `perf-spans.jsonl` to debug output so transform perf spans can be analyzed alongside action, dependency, and entrypoint logs.
- cb47dc2: Treat React `forwardRef` and `memo` as default code-remover HOCs, and inline same-file null component bases during Oxc static import value resolution.
- Updated dependencies
  - @wyw-in-js/processor-utils@2.0.0-alpha.1
  - @wyw-in-js/shared@2.0.0-alpha.1

## 2.0.0-alpha.0

### Major Changes

- bd2a46a: WyW-in-JS packages are now ESM-only and require Node.js >= 22.0.0.

  Breaking changes in v2:

  - CJS `require()` package entrypoints were removed; migrate configs/tooling to ESM (`import()` / `.mjs`).
  - Eval moved to the async ESM runner-based pipeline (`vm.SourceTextModule` + broker RPC), which is now the default path in v2.
  - Eval IPC and Babel preset config handling are stricter:
    - unsupported values in `__wywPreval` now fail explicitly instead of being silently coerced through JSON
    - function-valued preset/plugin options are supported when loaded from config files, while inline non-serializable options now error with migration guidance
    - `eval.globals` encoding and invalidation are more predictable and reject unsupported values earlier
  - `require()` inside eval now follows fallback semantics controlled by `eval.require` (`warn-and-run` / `error` / `off`).

  This release also updates the published bundler integrations, adapter coverage,
  and migration/docs around the v2 evaluator contract, and includes cache and
  warm-runner reuse fixes to keep the new evaluator on the expected performance
  path.

  Migration guide: https://wyw-in-js.dev/migration/v2

- d553b68: Complete the v2 Oxc migration across the core transform and evaluator pipeline.

  This cutover moves the runtime transform path to the Oxc-backed implementation, including module analysis, preeval rewrites, dangerous-code removal, processor application, template dependency extraction, shaker, collect, emit, and the async ESM evaluator flow.

  The public configuration contract is now Oxc-first, with `oxcOptions`, `EvalRule.oxcOptions`, and the `hybrid` resolver mode available across the updated packages. Processor integrations now rely on the engine-neutral `AstService` surface, and the migration includes cache, concurrency, and hot-path performance fixes needed to keep downstream behavior stable after the cutover. `@wyw-in-js/babel-preset` stays available only as a deprecated compatibility wrapper around the Oxc pipeline.

### Minor Changes

- 7754792: Expose the public Oxc configuration surface for the v2 transform path.

  This introduces `oxcOptions`, per-rule `EvalRule.oxcOptions`, and the opt-in `hybrid` eval resolver mode contract used by the Oxc-first pipeline. The default resolver remains `bundler`.

- 69004e7: Add a supported processor diagnostics seam that lets library-owned processors emit structured non-fatal warnings through WyW.

  This adds:

  - `BaseProcessor.addDiagnostic()` and typed diagnostics helpers in `@wyw-in-js/processor-utils`
  - normalized `diagnostics` output from `@wyw-in-js/transform`
  - diagnostics reporting in `@wyw-in-js/vite` and `@wyw-in-js/cli`

  Existing hard failures and metadata sidecar behavior stay intact.

- 1a72b47: Inline statically resolvable imported literals, fixed objects, compiled TypeScript enum objects, zero-argument helper returns, compound component alias metadata, same-module and post-declaration alias metadata, primitive processor metadata, and static metadata helper chains during Oxc pre-evaluation. Static-first value resolution is enabled by default with `eval.strategy: "hybrid"`, while `eval.strategy: "static"` rejects evaluator fallback.

  Cache per-file static metadata pre-evaluation results so multiple static exports from the same module do not repeat the same processor pre-evaluation work.

- 69004e7: Add opt-in metadata manifest output across `@wyw-in-js/shared`, `@wyw-in-js/transform`, `@wyw-in-js/vite`, and `@wyw-in-js/cli`.

  When `outputMetadata` is enabled:

  - `@wyw-in-js/transform` now returns normalized, public metadata alongside the existing transform result.
  - `@wyw-in-js/vite` emits `.wyw-in-js.json` sidecar assets during build.
  - `@wyw-in-js/cli` writes matching `.wyw-in-js.json` sidecar files and supports an `--output-metadata` flag.

  This keeps default JS/CSS output unchanged while exposing stable metadata artifacts for CLI, Vite, and transform consumers.

### Patch Changes

- d553b68: Fix several remaining Oxc parity gaps around processor-added imports, hoisted template dependencies, CommonJS export analysis, runtime source map composition, and live-binding CommonJS emit behavior.
- Updated dependencies
  - @wyw-in-js/processor-utils@2.0.0-alpha.0
  - @wyw-in-js/shared@2.0.0-alpha.0

## 1.0.8

### Patch Changes

- b416a98: Avoid unnecessary reexport expansion for `__wywPreval`-only entrypoints and isolate cached action trees per resolver context to prevent concurrent transform crashes.
- 33e4abf: Revalidate evaluated dependencies against disk during entrypoint freshness checks, and rethrow non-missing filesystem errors instead of treating them as cache invalidations.
- 21ecabf: Handle deleted or renamed dependency files during cache invalidation without swallowing unrelated filesystem errors.
- ba60b51: Add Vite 8 support without dropping Vite 5-7 compatibility, and fix destructured binding evaluation in `@wyw-in-js/transform` on newer Babel versions.

## 1.0.7

### Patch Changes

- 8158b6b: Coalesce `only` updates while a transform is already in flight so expanding export requests does not repeatedly restart the same entrypoint work.
- 6b1a996: Distinguish fully rewritten barrel sources from partial fallbacks during barrel import rewriting and annotate dependency reporting with rewrite phases so post-rewrite graphs are easier to interpret.
- 6a44e71: Extend barrel import rewriting to optimize passthrough exports in mixed modules while preserving fallback imports for local exports that still need the original barrel.
- 2a7b534: Keep invalidation-only dependencies for rewritten barrel imports out of normal dependency merging so optimized imports no longer need `noShake` as much to avoid repeated dependency churn.
- 7a2ec2e: Optimize pure re-export barrel files by caching barrel manifests and rewriting imports to leaf modules before CommonJS emission. This avoids repeated `only` supersede churn on large barrel files while preserving existing runtime behavior for non-optimized paths.
- c0497c3: Fix the transform shaker so exports pruned from output can still remain as local declarations when surviving code depends on them, including chained references, enums, and mixed variable export declarations.
- 26e85ef: Fix transform cache invalidation so entrypoints are evicted when direct or transitive dependencies change, preventing stale eval results from being reused across rebuilds.
- 225d70d: Add support for custom `conditionNames` during eval-time fallback resolution so transform can honor package export conditions in monorepo development setups, while keeping extension retry limited to extensionless subpath requests.
- 6daea8c: Invalidate cached barrel analysis when leaf export sets change, so warm rebuilds do not reuse stale rewritten `export *` output.
- 4fbbd20: Reuse already resolved leaf dependencies after barrel import rewriting so mixed-barrel optimization avoids re-resolving generated direct imports during the rewritten resolve pass.
- e9999e8: Avoid retrying extension guesses for scoped package roots when `conditionNames` is enabled.
- Updated dependencies
  - @wyw-in-js/processor-utils@1.0.5
  - @wyw-in-js/shared@1.0.5

## 1.0.6

### Patch Changes

- 038bf35: Strip Vite React Refresh helpers (`$RefreshReg$`/`$RefreshSig$`) when they are injected as local functions by `@vitejs/plugin-react@5.1.x`, preventing unintended code execution during eval.
- 9142eac: Fix processor skip handling to accept `Symbol('skip')` by description (instead of object identity), and warn once when the symbol identity mismatches `BaseProcessor.SKIP` to help diagnose duplicated dependencies.

## 1.0.5

### Patch Changes

- 3dec017: Fix cache invalidation storms when loader-provided code differs from filesystem code, keep the Vite resolver stable across repeated `configResolved` calls, and avoid eagerly walking dynamic import targets during eval-only runs (prevents `action handler is already set` and improves build performance on large projects).
- a936749: Drop Node.js <20 support (Node 18 is EOL).

  Note: WyW `1.0.0` already effectively required Node 20 in practice; this change makes the support policy explicit and
  aligns docs/CI accordingly.

  If DOM emulation is enabled (`features.happyDOM`), but `happy-dom` cannot be loaded via `require()` (ESM-only), WyW will
  fall back to running without DOM and print a one-time warning with guidance.

- 37d15aa: Fix Babel plugin/preset merging when keys are absolute paths from pnpm store (`node_modules/.pnpm/...`) so different packages don't get treated as duplicates.
- 9e08238: Fix cache invalidation when a file is first read from the filesystem and later provided by a bundler/loader, preventing stale transforms and related Vite build/dev issues.
- 3dec017: Add opt-in warnings to help identify dynamic and slow imports processed during prepare stage, with an `importOverrides.mock` hint for faster evaluation. Also support minimatch patterns in `importOverrides` keys to override groups of imports.
- Updated dependencies
  - @wyw-in-js/processor-utils@1.0.4
  - @wyw-in-js/shared@1.0.4

## 1.0.4

### Patch Changes

- Updated dependencies
  - @wyw-in-js/processor-utils@1.0.3
  - @wyw-in-js/shared@1.0.3

## 1.0.3

### Patch Changes

- a7ece53: Improve eval error diagnostics: when build-time evaluation fails due to browser-only globals (e.g. `window`), include a hint about using `importOverrides` / moving runtime-only code out of evaluated modules.
- d45b9bd: When expanding `export * from` to named re-exports, never include `default` (ESM export-star semantics). This avoids invalid code like duplicate default exports.
- f45e458: Fix shaker crash when removing anonymous default exports like `export default function() {}`.

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
