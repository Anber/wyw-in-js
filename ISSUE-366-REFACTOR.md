# Issue 366 OXC analysis refactor

## Status

- State: in progress
- Branch: `anber/fix-static-destructuring`
- Behavioral baseline: `9baff607f6121fc0d33db9119e2ce014d408834b`
- Refactor/optimization audit base: `30fc5f72`
- Current implementation checkpoint: `38c1088d`
- Next slice: O10 canonical binding identities and resolved-reference indexes

Issue #366 static destructuring support is behaviorally complete. The remaining
work reduces repeated analysis and converges duplicated semantic models without
changing public APIs, generated output, or fail-closed behavior.

## Preserved design contract

1. Share immutable syntax and program facts, not consumer policy.
2. Keep the three execution policies separate:
   - scope analysis is conservative over relevant syntax;
   - the shaker follows module execution and reachable callables;
   - static evaluation may discharge effects only through proofs.
3. Model destructuring as ordered operations. A property-path shortcut cannot
   represent computed keys, defaults, iterator effects, or assignment-target
   reference evaluation.
4. Binding patterns and assignment targets are different grammars. Preserve
   duplicate targets and source/write order.
5. Use structured property paths; never collapse `object["a.b"]` and
   `object.a.b`.
6. Cache only immutable facts unless the cache is explicitly scoped to one
   analysis/evaluation context.
7. Keep hot dispatch explicit and typed; avoid callback-heavy abstractions and
   avoid new per-node allocations without a focused benchmark.
8. Keep every production TypeScript file within its existing size limit.

## Current architecture

The structural refactor is complete and the global TypeScript size guard passes.

- `utils/oxc/` owns canonical node traversal, transparent runtime wrappers,
  function classification, raw pattern/assignment facts, lexical traversal,
  and structured property keys/paths.
- `scopeTraversal.ts`, `bindingResolution.ts`, and `mutationAnalysis.ts` own
  lexical facts, resolution, and mutation/alias propagation.
- Static evaluation is split into values, safety proofs, pattern execution,
  mutation replay, function runtime, conversions, and binary operations.
- Expression extraction delegates abstract-value analysis, static-local
  planning, and snapshot replay to cohesive leaves.
- The shaker delegates executable discovery, binding/callable provenance,
  receiver/pattern effects, module rewriting, invocation effects, and statement
  liveness to an acyclic module graph.
- The evaluator/purity SCC and extraction emitter remain together because the
  attempted boundaries would add cycles, callback plumbing, or hot-path calls.
  Revisit them only when a cohesive leaf appears.

## Remaining architecture work

- Complete the assignment-target evaluation schedule, including computed-key,
  default, and target-reference order. This blocks `PatternProgram`.
- Introduce canonical `BindingId`s, resolved-reference indexes, typed
  mutation/escape/receiver events, sorted timelines, and explicit unknown
  provenance.
- Introduce internal `EvalOutcome` so known `undefined`, unknown analysis, and
  abrupt completion are distinct.
- Split immutable extraction planning from source emission and replace the
  snapshot string lattice with an explicit abstract domain.
- Compile and cache ordered `PatternProgram`s, then interpret them in the
  evaluator, extractor, and shaker.
- Replace repeated alias/effect fixed-point scans with an indexed worklist and
  evaluate bounded monotone callable summaries.

`PatternProgram`, `EvalOutcome`, the abstract domain, and plan/emitter split are
correctness/architecture work. They are not performance claims without focused
measurements.

## Optimization backlog

Each slice is benchmarked against its immediate parent and remains independently
revertible.

### Completed

- [x] O1 — remove the redundant all-statement scan from shaker
      `bindingEffectsBefore` (`a476c176`).
- [x] O2 — memoize snapshot decisions within one extracted expression
      (`a476c176`).
- [x] O3 — replace four FIFO `shift()` queues with cursor queues
      (`a476c176`).
- [x] O4 — cache function-body syntax facts without sharing invocation state
      (`9da559b3`).
- [x] O13 — reuse one analysis-local cache of raw references
      (`56e64a45`).
- [x] O6 — seal mutation/hazard timelines and use binary-search range queries
      (`4acf460d`).
- [x] O7 — replace alias fixed-point rescans with indexed monotone worklists
      (`110d386b`).
- [x] O8 — cache immutable callable syntax facts for one provenance analysis
      (`48b8dbe8`).
- [x] O5a — fail closed on recursive function evaluation and cache only
      completed static-call purity proofs (`994d184e`).
- [x] O5b — replace eager full-map proof filtering with a lazy excluded-node
      timeline view (`38c1088d`).

### Open

| ID  | Change                                                                                                                  | Required guard                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| O9  | Index callable result paths by structured root/prefix.                                                                  | Preserve collision-free path equality and descendant semantics.                                                  |
| O10 | Add canonical `BindingId`s, resolved-reference indexes, and cached mutation identities.                                 | Build on O6's query API; this is a broad semantic foundation.                                                    |
| O11 | Convert recursive set-returning provenance collectors to caller-owned sinks and share policy-neutral forwarding syntax. | Keep assignment, projection, alias, and abruptness policy consumer-owned.                                        |
| O12 | Pre-index exports by top-level statement.                                                                               | Preserve re-export, default, and source-span ownership behavior.                                                 |
| O14 | Replace copied recursion-guard sets with backtracking or visit epochs.                                                  | Sibling branches must not leak visited state.                                                                    |
| O15 | Deduplicate wide-link delivery by `(link, node, direction, strength)`.                                                  | Preserve weak-to-strong promotion; land only if real high-arity profiles justify the extra state.                |
| O16 | Merge published/strong fact bookkeeping into explicit bit flags and build import indexes once.                          | Keep mutation seeds unpublished and final imported `UNKNOWN` facts non-reentrant; require a code/allocation win. |

### Order

1. Use O10 as the typed base for O9 and later `PatternProgram` work.
2. Revisit O15 on real wide destructuring/assignment profiles, not the
   synthetic stress case alone.
3. Take O16 only when it shrinks production code and allocations together.
4. Attempt O11, O12, and O14 only when profiles show material cost.

## Acceptance gates

### Correctness and static checks

- Full `packages/transform/src` suite and issue #366 characterization tests pass.
- Generated CSS, file counts, evaluation counts, and focused output hashes stay
  unchanged.
- `bun run --filter @wyw-in-js/transform build:types`
- `bun run --filter @wyw-in-js/transform lint`
- `bun run check:ts-size`
- Prettier and `git diff --check`

### Performance protocol

- Compare each optimization with its immediate parent using paired alternating
  fresh processes.
- Keep a focused workload for the optimized path and the tracked
  `shared-constants-functional-fanout` large-scenario regression gate.
- Record shaker, evaluator, preevaluation, `evalFile`, and wall timing where
  available; record peak RSS for persistent indexes/caches.
- Investigate repeatable whole-transform regressions above 5%.

## Current evidence

- Final structural graph: 1,360 passing tests; type build, lint, formatting,
  diff check, and size guard pass. Large-profile deltas versus the behavioral
  baseline were within 2%, and peak-RSS deltas were within 2%.
- Shared lexical traversal (`459dbba5`) unified scope boundaries and fixed
  initializer-free `var` redeclarations. Canonical visitor keys removed an
  order-dependent TypeScript decorator failure.
- Shaker reference migration (`1b4c6c63`) removed its duplicate traversal;
  differential checks found only the intended declaration-only difference.
- Shared assignment-target traversal (`72b17110`) preserved duplicates and
  source order across five consumers.
- Static property-key fast path (`cfc96b02`) preserved dynamic/symbol policy and
  improved the paired large workload by roughly 2–4%.
- O1–O3 (`a476c176`) pass 1,396 tests, one skip, and one existing todo. Type
  build, full lint, formatting, diff check, and the size guard pass.
- O1 focused profile: 800 member-heavy pairs, five ABBA blocks, 200 samples per
  side; trimmed mean `35.235 → 10.559 ms` (-70.03%), identical output.
- O2/O3 focused profile: 512 references with alias depth 32, same protocol;
  trimmed mean `10.544 → 8.568 ms` (-18.74%), identical output.
- O1–O3 large gate: 20 samples per side; wall -2.00%, evaluator -1.05%,
  preevaluation -1.33%, and `evalFile` -2.16%, with identical outputs and
  method counts.
- O4 (`9da559b3`) caches hoisted `var` names and ordered top-level declaration
  facts by function body. Environments and function wrappers remain
  per-invocation; two new isolation tests cover that boundary.
- O4 focused ABBA: 20 fresh processes per side, 1,024 calls to one function
  AST; trimmed mean `53.483 → 20.764 ms` (-61.18%), identical result hash.
- O13 (`56e64a45`) shares one raw-reference `WeakMap` only within
  `collectRootMutationHazards`. Focused ABBA: 24 processes per side; trimmed
  mean `37.736 → 30.480 ms` (-19.23%), identical hazard hash.
- The 8,192-member cache-pollution companion improved 17.28%; two peak-RSS
  samples per side showed no increase. Immediate-parent large gates preserved
  CSS bytes, file/evaluation counts, and method counts; attributable
  evaluator/preevaluation medians stayed within 1.5%.
- O6 (`4acf460d`) publishes separate immutable start/end timelines and
  allocation-free binary-search queries. Focused ABBA (24 processes per side)
  improved `258.805 → 11.627 ms` (-95.51% median) with the same checksum.
  Immediate-parent analysis-build median was +3.70% (paired +2.41%); peak RSS
  was +0.28%. The attempted shared-index follow-up had no benefit and was
  reverted.
- O7 (`110d386b`) uses reverse adjacency and a monotone weak/strong worklist.
  A 10,000-program differential check found zero membership or per-binding
  `byStart`/`byEnd` differences. Focused chain ABBA (24 processes per side)
  improved `1057.586 → 21.734 ms` (-97.94% median); 2,048→4,096 scaling was
  2.08x. Import fan-out improved `71.402 → 13.338 ms` (-81.32%).
- The wide-link stress case improved `147.564 → 65.981 ms` (-55.29%) but
  remains quadratic; O15 owns any further complexity. Chain peak RSS
  decreased `151,166,976 → 129,859,584` bytes (-14.10%, eight samples/side).
- O7's 20-sample large gate preserved 60 transformed files, 56 CSS files,
  8,540 CSS bytes, CSS SHA-256
  `eabb50e564b307716cb7cf089887d4f6bc23d3b55f0f7880e0621634f2e17d23`,
  and every method count. Wall median/trimmed mean changed -7.40%/-4.78%;
  evaluator trimmed mean +0.68%, preevaluation -7.00%, and `evalFile` -6.05%.
- O7 verification: 1,421 pass, one skip, one existing todo, zero failures
  (20-second timeout avoids the existing five-second eval-runner flake); type
  build, full lint, formatting, diff check, and size guard pass.
- O8 (`48b8dbe8`) replaces repeated callable assignment, mutation, callee, and
  local-catalog scans with syntax facts cached for one provenance analysis.
  Caller aliases, merged catalogs, recursion guards, and final effects remain
  invocation-local. Production code shrank by 23 lines.
- O8 focused ABBA (24 fresh processes per side, 1,024 calls, alias width 64)
  preserved generated-code SHA-256
  `8d86801a9b734704f2ac2a8c5e358897703b75798e124fea6e1769d9b92fa05c`;
  median improved `144.384 → 116.260 ms` (-19.48%) and paired geometric time
  improved 19.56%. The 256/512-call medians improved 16.48%/19.53%.
- A rejected module-global cache raised the 1,000-module pollution RSS median
  by 7.47%. The accepted analysis-local lifetime reduced single-module RSS to
  +0.02%; 100/500/1,000-module companions were -0.72%/+3.83%/+2.69%, with
  matching aggregate output hashes and no retention slope.
- O8's large gate (10 samples per side) preserved 60 transformed files, 56 CSS files,
  8,540 CSS bytes, and every method count; every median/trimmed regression was
  at most 2.6%. Final verification: 1,423 pass, one skip, one existing todo;
  type build, full lint, formatting, diff check, and size guard pass.
- O5a (`994d184e`) adds function-node recursion guards and an analysis-local
  completed-proof cache. Direct and mutual cycles now fail closed, same-named
  nested functions still evaluate, and partial/cyclic/throwing proofs cannot
  populate the completed cache. Production code grew by 55 lines; tests grew
  by 157 lines.
- O5a focused ABBA (24 fresh processes per side, 1,024 hazards and 1,024
  repeated proofs) preserved source/result hashes and improved the median
  `287.958 → 22.446 ms` (-92.20%). The matched no-proof control was +0.55%,
  the one-proof case +1.04%, completed-false proofs -74.37%, and the
  distinct-node/low-reuse control -46.66%.
- O5a's 2,048-proof peak-RSS median decreased 13.29%. Post-GC 100/500/1,000
  context companions showed no candidate retention slope: RSS medians changed
  -2.32%/-2.34%/-1.58%, with exact aggregate source/result hashes.
- O5a's large gate used 10 fresh processes per side and two measured runs per
  process. All 40 runs preserved 60 transformed files, 56 CSS files, 8,540 CSS
  bytes, and every method count; all tracked median/trimmed regressions stayed
  below 5%. Final verification: 1,432 pass, one skip, one existing todo; type
  build, full lint, formatting, diff check, and size guard pass.
- O5b (`38c1088d`) narrows proof contexts to an immutable `get`/`size` lookup
  and filters only requested timelines. A 10,000-case eager/lazy differential
  preserved nested exclusion, missing/empty, identity, ordering, and size
  semantics. Production grew by 28 lines and tests by 89 lines.
- O5b isolated ABBA improved one miss across 8,192 hazards by 3.99%, nested
  partial proofs by 11.18%, and distinct low-reuse proofs by 9.75%. The
  2,048-key adversarial full-read companion was +0.47%; peak RSS was -0.13%.
  Post-GC 100/500/1,000-context RSS changed -1.78%/+0.81%/-0.09%, with no
  candidate retention slope and exact aggregate hashes.
- O5b's first accidentally concurrent large timing run formally failed after
  two 4.6–5.3-second candidate spikes while other stress benches ran. The
  declared isolated rerun preserved the same exact 60/56/8,540 signature and
  all method counts across 40 runs; every median/trimmed delta was at most
  +2.96%. Final verification: 1,436 pass, one skip, one existing todo; type
  build, full lint, formatting, diff check, and size guard pass.

## Non-goals

- Increasing production size allowances.
- A universal solver shared by scope invalidation and shaker liveness.
- Supporting syntax beyond the issue #366 contract.
- Rewriting import/export source editing.
- Changing public transform APIs or generated output.
