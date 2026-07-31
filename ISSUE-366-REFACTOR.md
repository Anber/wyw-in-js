# Issue 366 OXC analysis refactor

## Status

- State: in progress
- Branch: `anber/fix-static-destructuring`
- Behavioral baseline: `9baff607f6121fc0d33db9119e2ce014d408834b`
- Refactor/optimization audit base: `30fc5f72`
- Current implementation checkpoint: `675fa936`
- Next slice: profile O11/O14; O10d and O15 stay deferred

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
  function classification, raw pattern/assignment facts, lexical and scoped
  reference traversal, and structured property keys/paths.
- `scopeTraversal.ts`, `bindingResolution.ts`, and `mutationAnalysis.ts` own
  lexical facts, cached reference resolution, and mutation/alias propagation.
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
- Add canonical lexical-slot identities only when a concrete consumer can
  replace name/scope identities without changing root or unresolved grouping.
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
- [x] O10a — share a private, selective binding-resolution cache across
      analysis consumers while keeping the single-binding path direct
      (`8507cced`).
- [x] O10b — share policy-parameterized scoped-reference collection and cache
      resolved reference attachments (`cdcf2990`, `31c63f67`).
- [x] O10c — cache only repeated scoped mutation keys by weak binding identity;
      root and unresolved names keep their direct shared namespace (`625d236e`).
- [x] O16 — merge published/strong mutation facts into one bit-state map,
      removing duplicate hazard Sets and their merge pass (`675fa936`).

### Open

| ID   | Change                                                                                                                  | Required guard                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| O9   | Index callable result paths by structured root/prefix.                                                                  | Preserve collision-free path equality and descendant semantics.                                   |
| O10d | Introduce canonical lexical-slot IDs only when resolved-reference or mutation consumers can adopt them together.        | Do not equate declaration-version `Binding` records with canonical lexical slots.                 |
| O11  | Convert recursive set-returning provenance collectors to caller-owned sinks and share policy-neutral forwarding syntax. | Keep assignment, projection, alias, and abruptness policy consumer-owned.                         |
| O12  | Pre-index exports by top-level statement.                                                                               | Preserve re-export, default, and source-span ownership behavior.                                  |
| O14  | Replace copied recursion-guard sets with backtracking or visit epochs.                                                  | Sibling branches must not leak visited state.                                                     |
| O15  | Deduplicate wide-link delivery by `(link, node, direction, strength)`.                                                  | Preserve weak-to-strong promotion; land only if real high-arity profiles justify the extra state. |

### Order

1. Defer O10d until an adopting consumer proves the required identity boundary.
2. Revisit O15 on real wide destructuring/assignment profiles, not the
   synthetic stress case alone.
3. Attempt O11, O12, and O14 only when profiles show material cost.

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
- O10a (`8507cced`, parent `9e307606`) shares completed binding resolutions in
  a private program-lifetime `WeakMap`. Only multi-declaration names are
  admitted; missing and single-declaration lookups bypass cache storage, and a
  specialized single-binding scope/range path preserves the cheap case.
  Positive-first and negative-first same-offset collisions remain name-guarded.
- O10a formal ABBA used 24 fresh processes per side. Shadowed lookup, mutation,
  and full collector medians improved 79.27%, 32.49%, and 50.64%. Unique lookup
  improved 3.44%; unique mutation was +0.32% and unique collector -0.53%. The
  no-hazard build control was +0.36% median and -2.19% trimmed mean. Every
  focused source/result/hazard signature matched.
- The 8,192-reference peak-RSS median changed +2.10% for the cache-heavy shadow
  case and +0.57% for unique names. Same-offset positive/negative collision
  controls improved 5.48%/4.45% with identical checksums.
- O10a's isolated large gate preserved 60 transformed files, 56 CSS files,
  8,540 CSS bytes, and every method count across 20 samples. Wall median/trimmed
  mean changed +1.72%/+0.58%; evaluator +0.63%/+1.38%, preevaluation
  +1.89%/+1.85%, and `evalFile` +0.34%/-0.01%.
- O10a grows production by 30 lines and tests by 55 lines because the hot
  single-binding path stays explicit. The next O10b slice owns the code-volume
  payoff by deleting duplicate reference traversals rather than generalizing
  policy-specific branches. Final verification: 1,439 pass, one skip, one
  existing todo; type build, full lint, formatting, diff check, and size guard
  pass. Independent semantic differential: 5,002/5,002 resolutions matched.
- O10b (`cdcf2990`, `31c63f67`) replaces duplicate scope/shaker collectors
  with one explicit binding/root-policy traversal and attaches completed
  resolutions to references through an analysis-lifetime `WeakMap`. Synthetic
  Object/Array snapshot lookups remain explicit. Production shrank by 30 lines;
  the shared collector's characterization tests add 180 lines.
- Differential checks matched 1,173/1,173 ordered scoped-reference projections
  and 5,002/5,002 binding resolutions. Focused collector, evaluator/extraction,
  and shaker suites passed; final verification is 1,446 pass, one skip, one
  existing todo, and zero failures. Type build, lint, formatting, diff check,
  and size guard pass.
- Focused paired fresh-process measurements preserved every signature. The
  duplicate-collector path improved 3.80% by trimmed mean, the direct shaker
  collector 2.86%, and the full shaker 1.02%. Amplified declaration/reference
  build controls stayed within 1.35%; a shorter declaration run was rejected
  after process outliers and is not used as evidence.
- The 500-module collector RSS gate changed -1.66% peak RSS and -3.31% post-GC
  heap; the full-shaker gate changed -0.13% peak RSS and +0.21% post-GC heap.
  Exact aggregate signatures matched in every sample.
- The first ten-sample large gate was RED at +11.66% wall median and +7.65%
  trimmed mean; an independent identical rerun was -0.98%/-0.48%. A
  predeclared 20-sample confirmation, with removal required above 5% wall,
  measured +3.82%/+3.47%. Its evaluator, preevaluation, dangerous-node removal,
  and `evalFile` median/trimmed deltas were +1.20%/+1.64%, +0.29%/+1.79%,
  +0.43%/+0.27%, and +6.61%/+4.91%. All runs preserved the exact 60-file,
  56-CSS-file, 8,540-byte signature and every method count.
- O10c (`625d236e`) lets the existing binding-fact memoizer accept an explicit
  Map or WeakMap backend while preserving its Map default. Mutation keys use a
  module-lifetime WeakMap only for non-root bindings; root and unresolved names
  remain bare and share their existing conservative namespace. The production
  change is +5 lines; independent semantic review passed.
- The direct repeated scoped-key ABBA improved 66.57% trimmed mean while its
  root bypass was +0.50%. A mutation-analysis workload with eight references
  per scoped binding improved 4.53%; the one-reference control changed +0.13%
  median and +1.81% trimmed mean. Every key and hazard signature matched.
- The eight-sample RSS gate changed -1.47% peak RSS, -1.51% post-GC RSS, and
  +0.53% post-GC heap. The first large run contained baseline process spikes
  and showed no candidate regression; an independent clean ten-sample gate was
  +2.39% wall median and +2.28% trimmed mean, with every attributable trimmed
  delta within 3.02% and the exact 60/56/8,540 signature and method counts.
- O10c verification: 1,446 pass, one skip, one existing todo, zero failures;
  type build, lint, formatting, diff check, and size guard pass.
- O16 (`675fa936`) stores publication and strong-propagation capability as
  orthogonal bits in the existing fact map. Modeled seeds remain unpublished,
  weak-to-strong promotion stays monotone, import broadcast stays strong-only,
  and final imported UNKNOWN publication does not re-enter the worklist.
  Production shrank by four lines and removes the per-binding hazard/sibling
  Sets plus the hazards-to-facts merge pass. Independent semantic review passed.
- A 5,000-program differential matched exact per-binding membership and
  `byStart`/`byEnd` order. Only the unconsumed outer Map insertion order differs.
  Repeated- and single-reference mutation-analysis ABBA improved 3.12% and
  4.96% by trimmed mean, with exact hazard signatures.
- The eight-sample allocation gate improved peak RSS 3.60%, post-GC RSS 3.43%,
  and post-GC heap 7.14%. An initial noisy large gate favored the candidate; an
  independent clean ten-sample gate improved wall median/trimmed mean
  2.24%/2.22%, with all tracked components improving and the exact 60/56/8,540
  signature and method counts.
- O16 verification: 1,446 pass, one skip, one existing todo, zero failures;
  type build, lint, formatting, diff check, and size guard pass.

## Non-goals

- Increasing production size allowances.
- A universal solver shared by scope invalidation and shaker liveness.
- Supporting syntax beyond the issue #366 contract.
- Rewriting import/export source editing.
- Changing public transform APIs or generated output.
