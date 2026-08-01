# Issue 366 OXC analysis refactor

## Status

- State: complete
- Branch: `anber/fix-static-destructuring`
- Behavioral baseline: `9baff607f6121fc0d33db9119e2ce014d408834b`
- Refactor/optimization audit base: `30fc5f72`
- Program-facts checkpoint: `3fd58f9b`
- Current graph slice: this commit
- Next slice: none; reopen only from a measured profile

Issue #366 static destructuring support and the planned analysis optimization are
behaviorally complete. Final verification must preserve APIs, output, and
fail-closed behavior.

## Preserved semantic and design contract

1. Share immutable syntax and program facts, not consumer policy.
2. Keep execution policies separate: scope analysis is conservative, the shaker
   follows module execution and reachable callables, and static evaluation may
   discharge effects only through proofs.
3. Model destructuring as ordered operations. Property-path shortcuts cannot
   represent computed keys, defaults, iterator effects, or target-reference
   evaluation.
4. Treat binding patterns and assignment targets as different grammars. Preserve
   duplicate targets and source/write order.
5. Use structured property paths; never collapse `object["a.b"]` and
   `object.a.b`.
6. Cache only immutable facts unless lifetime is explicitly limited to one
   analysis or evaluation context.
7. Keep hot dispatch explicit and typed. Require a focused benchmark before
   adding callback-heavy abstractions or per-node allocations.
8. Keep every production TypeScript file within its existing size limit.

## Current architecture

The structural refactor is complete and the global TypeScript size guard passes.

- `utils/oxc/` owns canonical traversal, transparent runtime wrappers, function
  classification, raw pattern/assignment facts, lexical/scoped references, and
  structured property keys and paths.
- `scopeTraversal.ts`, `bindingResolution.ts`, and `mutationAnalysis.ts` own
  lexical facts, cached reference resolution, and mutation/alias propagation.
- Static evaluation is split into values, safety proofs, pattern execution,
  mutation replay, function runtime, conversions, and binary operations.
- Expression extraction delegates abstract-value analysis, static-local
  planning, and snapshot replay to cohesive leaves.
- The shaker delegates discovery, binding/callable provenance, receiver/pattern
  effects, module rewriting, invocation effects, and statement liveness to an
  acyclic module graph.
- The evaluator/purity SCC and extraction emitter remain together: attempted
  splits added cycles, callback plumbing, or hot-path calls. Revisit only when a
  cohesive leaf emerges.

| Commit     | Structural result                                                           |
| ---------- | --------------------------------------------------------------------------- |
| `459dbba5` | Shared lexical traversal and correct initializer-free `var` redeclarations. |
| `1b4c6c63` | Shaker references moved to the shared traversal.                            |
| `72b17110` | Shared assignment-target traversal preserves duplicates and order.          |
| `cfc96b02` | Static property-key fast path preserves dynamic/symbol policy.              |

## Current performance correction

Before Program-level reuse, the accumulated refactor made the tracked large
fanout 15–25% slower than bare `main`; a synthetic 64-import/64-result case was
roughly 200x slower. Profiling isolated two multipliers.

- Checkpoint `3fd58f9b` caches Program-identity scope/mutation and module facts
  with four bounded request variants, snapshots mutable collection results, and
  skips an unused perf-emitter static plan. The large fanout moved from 112
  analysis builds to 56 builds plus 56 hits.
- Opaque imported-call results formed pairwise aliases to every root import and
  repeatedly closed through callable-result provenance.

### Graph remediation

The accepted design keeps exact graph identities without materializing their
transitive closure into every statement.

- Imported roots share one virtual cohort tag. It becomes concrete only at the
  liveness/effect boundary; callable/accessor/class suffix lookup stays exact.
- Callable-result provenance is a directed lazy closure. Terminal dependencies
  become binding roots, so reverse liveness reaches returned, bound,
  conditional, and member-stored callables without dense aliases.
- Object-rest copies keep directed source/dependent edges. Receiver history is
  attached only to direct effect origins and carries an earliest-statement
  summary for cutoff-aware reverse queries.
- Full resolver-expanded bindings remain available for ordinary dependency and
  ownerless-reference liveness. Imported nested history uses an explicit
  virtual bucket.

The 39-cell scaling gate now covers import/result grids, opaque result chains,
alias chains and cycles, dormant/invoked local result chains, directed rest
chains, and the exact all-mutations worst case. Every cell is bound to source,
output, and retained-import goldens. In the worst tracked case (256 rest copies
followed by 256 ordered nested mutations), median shaker time moved from about
2.40 s to roughly 0.12–0.14 s while preserving the exact output.

A later profile showed that repeated shakes of one cached `Program` still rebuilt
the option-invariant statement graph. The current slice now caches those facts by
`Program`, source, and module mode while rebuilding requested-export liveness and
side-effect policy for every call. Plain Identifiers also bypass the generic OXC
visitor-key loop and share one frozen empty child list; typed and decorated
Identifiers stay on the authoritative visitor-key path.

On the complete current stack, a 14-sample focused ABBA against bare `main`
measured evaluator `25.05 -> 11.45 ms` (-54.29%), preevaluation
`26.70 -> 24.30 ms` (-8.99%), template processing `13.35 -> 10.95 ms`
(-17.98%), and dangerous-code removal `11.85 -> 11.75 ms` (-0.84%). The same 60
files produced 56 CSS files and 8,540 CSS bytes. The VM-heavy wall and `evalFile`
medians improved by 14.55% and 13.44%, respectively, but remain high-variance.

The full production matrix preserved all 12 output signatures. Larger targeted
reruns eliminated the two apparent regressions from the first six-sample pass:
small overlap reexports measured -13.80% over 20 samples, medium wildcard fanout
-18.11% over 14 samples, and small functional fanout -28.32% over 14 samples.
The new slice itself measured evaluator -69.80% and dangerous-code removal -4.41%
against its immediate parent. Peak RSS on the large static case was effectively
flat against that parent (`227.61 -> 226.84 MiB`, -0.34%); the complete branch is
about 4 MiB above bare `main` (`222.55 -> 226.63 MiB`, +1.83%).

The remaining quadratic shape is output-sensitive: that fixture has a
quadratic number of exact prior-effect relationships. A future lower-constant
implementation would need reason-tagged effect lanes and an SCC-condensed
directed history graph; a weak/undirected alias component is unsound for
multi-source joins.

## Remaining architecture work

- Complete assignment-target evaluation order for computed keys, defaults, and
  target references; this blocks `PatternProgram`.
- Introduce `EvalOutcome` to distinguish known `undefined`, unknown analysis,
  and abrupt completion.
- Split immutable extraction planning from emission and replace the snapshot
  string lattice with an explicit abstract domain.
- Compile and cache ordered `PatternProgram`s for evaluator, extractor, and
  shaker interpretation.
- Finish indexed alias/effect propagation and evaluate bounded monotone callable
  summaries.

`PatternProgram`, `EvalOutcome`, the abstract domain, and the plan/emitter
split are correctness/architecture work, not performance claims without focused
measurements.

## Completed optimizations

Results are headline focused, immediate-parent measurements; accepted slices
also preserved their declared output/signature gates.

| ID    | Commit                 | Change                                                                       | Headline focused result                           |
| ----- | ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| O1–O3 | `a476c176`             | Remove redundant shaker scan, memoize snapshot decisions, use cursor queues. | -70.03% member path; -18.74% alias/snapshot path. |
| O4    | `9da559b3`             | Cache function-body syntax facts; keep invocation state local.               | -61.18%.                                          |
| O13   | `56e64a45`             | Reuse raw references within one hazard analysis.                             | -19.23%.                                          |
| O6    | `4acf460d`             | Seal mutation timelines and binary-search range queries.                     | -95.51%.                                          |
| O7    | `110d386b`             | Replace alias rescans with an indexed monotone worklist.                     | -97.94% chain; -81.32% import fanout.             |
| O8    | `48b8dbe8`             | Cache callable syntax facts for one provenance analysis.                     | -19.48%; no retained global cache.                |
| O5a   | `994d184e`             | Fail closed on recursion; cache completed purity proofs only.                | -92.20%.                                          |
| O5b   | `38c1088d`             | Lazily filter excluded-node mutation timelines.                              | 3.99–11.18% across focused proof paths.           |
| O10a  | `8507cced`             | Selectively share binding resolutions; keep direct single-binding path.      | 32.49–79.27% on shadowed consumers.               |
| O10b  | `cdcf2990`, `31c63f67` | Share policy-driven reference traversal and resolved attachments.            | 1.02–3.80% across focused consumers.              |
| O10c  | `625d236e`             | Cache repeated scoped mutation keys by weak binding identity.                | -66.57% key path; -4.53% repeated mutation path.  |
| O16   | `675fa936`             | Merge publication/strength facts into one bit-state map.                     | 3.12–4.96%; lower allocation.                     |
| O11   | `04ec7a7d`             | Append alias provenance into one caller-owned set.                           | -76.96% nested path; -7.41% focused shaker.       |
| O9    | `11ee6a15`             | Lazily bucket callable result paths by canonical root.                       | -92.01% resolver; -48.28% dynamic shaker.         |
| Graph | this commit            | Virtual imported cohort and directed, cutoff-aware receiver history.         | About 20x at 256 ordered nested mutations.        |
| Cache | this commit            | Reuse option-invariant shaker facts for one parsed Program.                  | -69.80% evaluator versus the immediate parent.    |
| Walk  | this commit            | Fast-path plain Identifiers and share their empty child list.                | Removes the remaining dangerous-code regression.  |

## Open optimization backlog

| ID   | Change                                                                 | Required guard                                                                     |
| ---- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| O10d | Add canonical lexical-slot IDs only with a joint adopting consumer.    | Never equate declaration-version `Binding` records with lexical slots.             |
| O12  | Pre-index exports by top-level statement.                              | Preserve re-export/default/span ownership; require a production-sized CJS profile. |
| O14  | Replace copied recursion guards with backtracking or visit epochs.     | Sibling branches must not leak visited state.                                      |
| O15  | Deduplicate wide-link delivery by `(link, node, direction, strength)`. | Preserve weak-to-strong promotion; require a real high-arity profile.              |

Order: defer O10d until its identity boundary has a consumer; revisit O15 on real
wide profiles; attempt O12 and O14 only when profiles show material cost.

## Acceptance gates

### Correctness and static checks

- Run the full `packages/transform/src` suite and issue #366 characterization tests.
- Preserve generated CSS, file/evaluation counts, method counts, focused hashes,
  and any graph output/import goldens.
- Run:

  ```sh
  bun run --filter @wyw-in-js/transform build:types
  bun run --filter @wyw-in-js/transform lint
  bun run check:ts-size
  ```

- Run the repository Prettier check and `git diff --check`.

### Performance protocol

- Compare each optimization with its immediate parent in paired, alternating,
  fresh processes.
- Keep both a focused workload and the tracked
  `shared-constants-functional-fanout` large-scenario gate.
- Record shaker, evaluator, preevaluation, `evalFile`, and wall time where
  available; record peak RSS for persistent indexes/caches.
- Require exact declared signatures/goldens and investigate repeatable
  whole-transform regressions above 5%.
- For the graph slice, run the direct and chained/cyclic scaling gates before
  making any final timing, golden, or stability claim.

Final evidence: all 226 focused tests pass. The full transform run reached 1,513
passes, one pre-existing skip, and one todo; `issue-99.symbol-identity` hit its
5-second parallel-suite timeout but passed alone in 0.68 seconds. Types, lint,
TypeScript size, Prettier, and `git diff --check` pass. All 39 scaling goldens
match, and the production ABBA results are recorded above.

## Non-goals

- Increasing production size allowances.
- A universal solver shared by scope invalidation and shaker liveness.
- Supporting syntax beyond the issue #366 contract.
- Rewriting import/export source editing.
- Changing public transform APIs or generated output.
