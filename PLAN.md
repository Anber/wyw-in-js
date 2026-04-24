# Oxc Migration Plan

## Current State

- Core `@wyw-in-js/transform` runtime/build path is on Oxc.
- Full local validation is green on branch `anber/oxc-migration-cutover`.
- The committed cutover snapshot is `0d7290ed` (`feat(transform): cut over core pipeline to oxc`).
- Remaining first-party Babel usage outside the core path is intentionally deferred for now:
  - `packages/babel-preset`
  - `linaria/packages/interop`
  - `linaria/packages/postcss-linaria`
- Main open problem is performance: baseline comparison still shows a Darkmatter regression after the Oxc cutover.

## Goals

1. Remove the Darkmatter perf regression without weakening behavior or test coverage.
2. Keep existing Oxc parity and validation green while optimizing.
3. Only after perf stabilizes, resume the remaining Babel cleanup outside the core transform path.

## Optimization Order

1. Add narrow perf instrumentation around the Oxc hot path so timing can be attributed to:
   - `applyOxcProcessors`
   - template dependency extraction
   - preeval transforms
   - shaker / prepare
   - emit
2. Land the cheapest low-risk wins first in `applyOxcProcessors`:
   - short-circuit when the module imports no known processors
   - reuse the first `collectProcessorUsages` result when extraction does not rewrite the code
3. Introduce shared exact `(filename, code)` parse caching across the Oxc helper stages that currently reparse the same module text.
4. Remove duplicate import/export reparsing in the processor path by reusing already-available AST/module-analysis results.
5. Re-run the perf baseline after each block and stop as soon as Darkmatter returns to parity or better.
6. If the cheap wins are not enough, move to the next tier:
   - collapse adjacent Oxc stages that currently do full extra walks over unchanged code
   - reduce repeated replacement sorting / full-string rewrite passes
   - consider lower-level Oxc-native transforms only for the hot spots proven by measurements

## Guardrails

- Do not rewrite behavior to chase perf.
- Do not delete old regression coverage to make optimization easier.
- Do not introduce a second parallel implementation path unless measurements prove it is necessary.
- Treat existing passing transform, adapter, and validation suites as the behavior contract.

## Findings

- `applyOxcProcessors` no longer reparses through each cleanup subpass; the remaining cost in that area is now the per-iteration analysis itself, not subpass-local reparsing.
- `oxcPreevalTransforms` still has whole-module duplication, but `import.meta.env` is separated from dynamic-import / require-fallback rewrites by the dangerous-code stage. A full single-pass collapse across all three would require reordering or offset rebasing, so the next low-risk slice is to merge the post-dangerous dynamic-import and require-fallback passes first.
- `collectOxcTemplateDependencies` now shares parse results, but still performs several whole-AST analysis passes (`bindings`, root mutations, used names, target expression discovery) that can be fused later if the new preeval sublabels point there.
- Inside `collectOxcTemplateDependencies`, the remaining cheap wins are now more about analysis reuse than parsing: repeated subtree `findReferences(...)` walks and per-recursion `ancestors` array copies still exist on the hot path.
- Fine-grained Oxc preeval timing is now available through the existing event-emitter path, so future perf work should follow measured hot buckets instead of broad guesses.
- A full `@wyw-in-js/transform test` run after the current perf work still surfaces older non-perf failures outside the touched files (`processImports` expectation drift and flaky temp-file concurrency cases). The preeval/processor suites touched by this optimization block are green; the unrelated package-test debt should be tracked separately from the hot-path work.
- Re-measurement after the latest preeval work shows the merged dynamic-import / require-fallback pass is effectively free in Darkmatter. The remaining preeval cost is dominated by `processTemplate`, then `removeDangerousCode`; `importMetaEnv` is materially smaller and no longer the best next target.
- `collectOxcTemplateDependencies` no longer copies `ancestors` arrays on every recursive step and now reuses cached subtree reference scans plus binding lookups during extraction. This is a low-risk runtime optimization layer over the existing semantics, not a logic rewrite.
- Snapshot `oxc-wip-20260424-r3` confirms the template-extraction caching pass helped without moving the bottleneck: baseline comparison is now `IMPROVEMENT`, Darkmatter is back in the stable band, and the hottest remaining preeval buckets are still `processTemplate`, then `removeDangerousCode`.
- `collectOxcTemplateDependencies` can absorb more of `processTemplate` by sharing one `Program` analysis between template discovery and extraction context setup. The low-risk version is to fuse `bindings`, `usedNames`, and target discovery while leaving root-mutation semantics untouched.
- The shared `Program`-analysis pass did surface a `build:types` regression during the first full `validate` run, but it was only a visitor-narrowing issue: moving template / target collection into a single pre-narrow helper preserved the optimization and restored the type gate without backing out the analysis fusion.
- `validate.sh --snapshot-release` on a dirty worktree measures the checked-out snapshot ref, not the current local changes. For perf work on uncommitted code, the reliable path is to snapshot a temporary tree commit (for example via `git stash create`) and compare that output instead of trusting a release snapshot built from `HEAD`.
- Corrected snapshot `oxc-wip-20260424-r5` shows the shared-analysis pass behaved as intended end to end: Portal improved further, Darkmatter build returned to a slight improvement/stable band, and only Darkmatter typecheck still warns. The remaining hot portal-side preeval buckets are `processTemplate`, then `removeDangerousCode`.
- Attempted fixed-point optimization inside `removeDangerousCode` did not survive end-to-end measurement: snapshot `oxc-wip-20260424-r6` regressed from `r5` (`Darkmatter build 16.387s` vs `15.260s`, total `18.185s` vs `17.192s`) even though focused preeval tests stayed green. That experiment is rejected and must stay reverted.
- The next low-risk hotspot inside `processTemplate` is no longer parsing itself but repeated lookup work during extraction: `resolveBindingAt` still allocates and sorts per reference, and insertion-point ownership still does a linear `program.body.find(...)` for every extracted expression.
- Snapshot `oxc-wip-20260424-r7` confirms the first lookup-overhead pass is safe: versus `r5`, Portal improved again (`53.422s`, `-1.17%`), Darkmatter typecheck improved (`1.778s`, `-7.97%`), and Darkmatter build/total stayed inside the stable band (`15.768s`, `+3.33%`; `17.546s`, `+2.06%`). That keeps the focus on `processTemplate`, but the next cheap target should move away from parse/lookup and into recursive evaluation overhead.
- The remaining low-risk extraction overhead now includes recursive stack cloning in static evaluation and hoist traversal (`[...stack, name]` plus repeated `includes()` checks). That is a better next candidate than revisiting `removeDangerousCode`, because it sits directly in the still-hot `processTemplate` bucket and does not require changing pass ordering.
- Snapshot `oxc-wip-20260424-r8` rejects that recursion-stack hypothesis: versus `r7`, Darkmatter regressed sharply (`build 17.708s`, `+12.30%`; `total 19.464s`, `+10.93%`), and versus the stable `r5` snapshot it became a `REGRESSION_FAIL` (`build +16.04%`). The focused suites stayed green, so the cost is performance-only, but that is enough to reject the change and keep the older stack behavior.
- After rejecting the stack rewrite, the next `processTemplate` target should be narrower than “static evaluation internals”. The remaining promising area is reference/scope traversal reuse (`findReferences`, `hasLocalBinding`, repeated subtree walks) rather than recursion bookkeeping.
- Snapshot `oxc-wip-20260424-r9` validates that narrower approach: caching scope-chain binding checks inside `findReferences` keeps Darkmatter in the safe band and improves it slightly versus both `r7` and `r5` (`total 17.057s`, `-2.79%` vs `r7`, `-0.79%` vs `r5`). Portal slowed relative to `r7` and `r5`, but stayed within the stable band (`55.721s`, `+4.30%` vs `r7`, `+3.08%` vs `r5`), so this slice is acceptable to keep while the next target shifts to Portal-heavy work.
- With `r9`, the remaining visible perf problem is no longer Darkmatter regression but Portal-side `processTemplate` cost. The next optimization should therefore target Portal-heavy subtree/reference duplication before revisiting any risky `removeDangerousCode` or recursion rewrites.
- `transform:preeval:processTemplate` is now instrumented internally through `applyOxcProcessors`, so the next profile can attribute time to imports, usage discovery, dependency extraction, reparsing, used-name collection, processor instantiation/callback, and cleanup instead of treating the whole processor path as one opaque bucket.
- Snapshot `oxc-wip-20260424-r10` makes that attribution actionable: versus `r5`, Portal regressed (`55.976s`, `+3.55%`) while Darkmatter improved (`14.769s` build, `-3.22%`; `16.598s` total, `-3.46%`). The useful result is the sub-breakdown itself: `processTemplate:imports` dominates both Darkmatter (`804ms` of `1624ms`) and Portal (`1894ms` of `3480ms`), while `processors`, `deps`, `reparse`, and `usedNames` are all materially smaller.
- The next bounded target should therefore move into import/processor discovery inside `applyOxcProcessors`, not back into template-dependency extraction. The safest first slice is to reduce repeated processor-resolution work and re-measure before attempting a new dedicated import-only analyzer.
- Snapshot `oxc-wip-20260424-r11` rejects that lookup-cache hypothesis as a meaningful end-to-end win. Portal returned to the good band (`54.033s`, essentially flat vs `r5`), but Darkmatter regressed (`16.233s` build, `+6.38%`; `18.004s` total, `+4.72%`), and the live preeval sublabels showed `processTemplate:imports` staying dominant in both Darkmatter (`1182ms`) and Portal (`1902ms`). Final processor-resolution caching is therefore acceptable to keep only as a tiny local improvement layer, not as the main remaining fix.
- With lookup reuse exhausted, the next justified move is structural but still local: give `applyOxcProcessors` an imports-only collector that keeps direct imports, CommonJS require declarators, and namespace/member resolution, while skipping the rest of the export/reexport analysis that the processor path never consumes.
- Snapshot `oxc-wip-20260424-r12` validates that imports-only move. Versus `r11`, Portal improved from `54.033s` to `51.990s` (`-3.78%`), Darkmatter build from `16.233s` to `14.450s` (`-10.99%`), and Darkmatter total from `18.004s` to `16.127s` (`-10.43%`). Versus the stable `r5` snapshot, the same block is still clearly positive (`Portal -3.82%`, `Darkmatter build -5.31%`, `Darkmatter total -6.19%`).
- The live `processTemplate:*` sublabels confirm the mechanism, not just the totals: Darkmatter `processTemplate:imports` dropped from `1182ms` in `r11` to `843ms`, and Portal from `1902ms` to `1586ms`. That makes the imports-only collector an accepted hotspot fix rather than noise.

## Progress

- Oxc cutover is complete for the core transform/evaluator/build path.
- Validation gate is green.
- Perf baseline has been captured and compared.
- Block 1 done: `applyOxcProcessors` now short-circuits the no-resolved-processor and no-usage paths, and reuses the first processor-usage scan when template extraction leaves code unchanged. Added regression coverage for the no-processor path; targeted `applyOxcProcessors` tests are green.
- Block 2 done: processor import discovery no longer reparses source text through `collectOxcExportsAndImports`; the analyzer now has a parsed-program entrypoint and `applyOxcProcessors` reuses its existing AST. Targeted `applyOxcProcessors` and `collectOxcExportsAndImports` tests are green.
- Block 3 done: added a shared capped Oxc parse cache for exact `(filename, code, sourceType)` reuse and connected it to the processor/template-dependency/import-analysis path. Targeted `applyOxcProcessors`, `collectOxcExportsAndImports`, and `collectOxcTemplateDependencies` tests are green.
- Block 4 done: re-measured the optimized path against `recalc-20260418-v2-esm-evaluator-snap-r1` using snapshot `oxc-wip-20260424-r1`. Result: `Portal build 53.669s` (`-9.72%`), `Darkmatter build 15.462s` (`+0.29%`, stable), `Darkmatter total 17.186s` (`-0.08%`, stable). The previous Darkmatter regression is no longer reproduced by the baseline comparator.
- Block 5 done: restored fine-grained Oxc preeval timing sublabels on the existing `EventEmitter` path (`processTemplate`, `importMetaEnv`, `removeDangerousCode`, `dynamicImport`, `requireFallback`) and covered them with focused tests. Future profiling can now target the hottest preeval substep instead of only the aggregate `transform:preeval` bucket.
- Block 6 done: collapsed the parse-heavy cleanup loop in `applyOxcProcessors` so each fixed-point iteration reuses one parsed program plus shared statement/reference/binding analysis, then applies merged cleanup removals in one shot. Targeted `applyOxcProcessors`, `prepareCode`, and `oxc-preeval-stage` tests remain green.
- Block 7 done: merged the post-dangerous dynamic-import and require-fallback rewrites in `oxcPreevalTransforms` into one parsed-program scan plus one replacement application, while preserving the existing perf sublabels and keeping standalone transform tests green. Targeted `oxc-preeval-transforms`, `oxc-preeval-stage`, and `prepareCode` suites are green.
- Block 8 done: re-measured against `recalc-20260418-v2-esm-evaluator-snap-r1` using snapshot `oxc-wip-20260424-r2`. Result: `Portal build 54.750s` (`-7.90%`), `Darkmatter build 16.019s` (`+3.90%`, stable), `Darkmatter total 18.017s` (`+4.75%`, stable but noisier than `r1`). Updated preeval buckets confirm `processTemplate` is still the main target; merged dynamic/require rewrites are near-zero.
- Block 9 done: reduced `collectOxcTemplateDependencies` hot-path overhead by reusing subtree reference analysis, caching binding resolution by reference position, and removing recursive `ancestors` array copies from the local walkers. Focused `collectOxcTemplateDependencies`, `applyOxcProcessors`, `prepareCode`, and `oxc-preeval-stage` suites are green.
- Block 10 done: re-measured against `recalc-20260418-v2-esm-evaluator-snap-r1` using snapshot `oxc-wip-20260424-r3`. Result: `Portal build 54.591s` (`-8.17%`), `Darkmatter build 15.676s` (`+1.67%`, stable), `Darkmatter total 17.476s` (`+1.60%`, stable). Versus `r2`, Darkmatter total improved by `0.541s` and typecheck by `0.198s`; the perf comparator reports overall `IMPROVEMENT`.
- Block 11 done: fused `collectOxcTemplateDependencies` whole-program setup so template / expression discovery, `bindings`, and `usedNames` come from one shared `Program` analysis that extraction reuses directly. The first full validation exposed only a TypeScript narrowing bug in the visitor; moving target collection into a pre-narrow helper kept the optimization and restored `build:types`. Focused `collectOxcTemplateDependencies`, `applyOxcProcessors`, `prepareCode`, `oxc-preeval-stage`, `@wyw-in-js/transform build:esm`, and `build:types` are green.
- Block 12 done: corrected perf measurement for the shared-analysis pass. The first `r4b` snapshot was invalid because `snapshot-release` measured committed `HEAD` after stashing local changes; the real dirty-head snapshot `oxc-wip-20260424-r5` was captured from a temporary tree commit. Result versus baseline: `Portal build 54.057s` (`-9.06%`), `Darkmatter build 15.260s` (`-1.02%`), `Darkmatter total 17.192s` (`-0.05%`), with only `Darkmatter typecheck 1.932s` (`+8.42%`) still in warning territory. Versus `r3`, Portal improved by `0.534s` and Darkmatter total by `0.284s`.
- Block 13 done: measured and rejected the first `removeDangerousCode` fixed-point rewrite. Focused tests and `build:types` stayed green, but dirty-head snapshot `oxc-wip-20260424-r6` regressed versus `r5` enough to fail the experiment, so the candidate-list/cached-forbidden implementation was reverted instead of being compacted further.
- Block 14 done: reduced `processTemplate` lookup overhead inside `collectOxcTemplateDependencies` by replacing per-reference binding `filter(...).sort(...)[0]` with cached non-allocating selection and by precomputing insertion owners for extracted expressions instead of doing `program.body.find(...)` each time. Focused `collectOxcTemplateDependencies`-dependent suites and `build:types` were green, and dirty-head snapshot `oxc-wip-20260424-r7` compared to `r5` as overall `IMPROVEMENT`.
- Block 15 done: measured and rejected the recursive stack-cloning rewrite in `collectOxcTemplateDependencies`. Focused suites and `build:types` stayed green, but dirty-head snapshot `oxc-wip-20260424-r8` regressed hard enough in Darkmatter to fail the experiment, so the stack-helper changes were backed out instead of being iterated further.
- Block 16 done: narrowed `processTemplate` reference traversal by caching scope-chain `hasLocalBinding` results inside `findReferences`. Focused `collectOxcTemplateDependencies`-dependent suites and `build:types` were green, and dirty-head snapshot `oxc-wip-20260424-r9` stayed stable versus `r7` while improving Darkmatter total/build and keeping overall status at `IMPROVEMENT` versus `r5`.
- Block 17 done: added internal `processTemplate:*` perf sublabels in `applyOxcProcessors` (`imports`, `usages`, `deps`, `reparse`, `usedNames`, `processors`, `cleanup`) and covered them through the existing Oxc preeval perf-label test. Focused `applyOxcProcessors`, `prepareCode`, `oxc-preeval-stage`, and `build:types` gates are green.
- Block 18 done: captured dirty-head snapshot `oxc-wip-20260424-r10` from a temporary tree commit and used the new `processTemplate:*` sublabels to isolate the remaining hot bucket. Result: `processTemplate:imports` is the dominant internal substep in both Darkmatter and Portal, far ahead of dependency extraction or processor instantiation.
- Block 19 done: added final processor-resolution caching in `processorLookup` and covered it with a focused `applyOxcProcessors` regression test. Focused `applyOxcProcessors`, `prepareCode`, `oxc-preeval-stage`, and `build:types` gates stayed green, but dirty-head snapshot `oxc-wip-20260424-r11` showed no material import-bucket win and regressed Darkmatter overall, so this closes the lookup-cache hypothesis rather than the hotspot.
- Block 20 done: switched `applyOxcProcessors` from the full `collectOxcExportsAndImportsFromProgram` path to an imports-only collector that preserves direct imports, transpiled CommonJS require imports, and namespace/member-derived processor tags while skipping export/reexport work. Focused `applyOxcProcessors`, `prepareCode`, `oxc-preeval-stage`, `collectExportsAndImports`, and `build:types` gates stayed green, and dirty-head snapshot `oxc-wip-20260424-r12` confirmed a real end-to-end win.
- Current block: re-attribute the now-smaller `processTemplate:imports` bucket before another structural rewrite. The priority is to split the remaining import cost into analyzer/traversal work versus processor lookup work so the next optimization targets the actual residual hotspot instead of repeating the `r11` guesswork.
