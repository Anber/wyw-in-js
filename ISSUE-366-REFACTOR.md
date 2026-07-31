# Issue 366 OXC analysis refactor

## Status

- State: in progress
- Feature branch: `anber/fix-static-destructuring`
- Behavioral baseline: `9baff607f6121fc0d33db9119e2ce014d408834b`
- Current implementation checkpoint: `a476c176`
- Optimization audit base: `30fc5f72`
- Target: preserve the full static destructuring support implemented for
  issue #366 while replacing duplicated semantic models with shared,
  typed analysis primitives.

## Problem statement

The issue #366 implementation is behaviorally complete, but it expanded four
production modules far beyond the repository's line-count guard:

| Module                                                   | Baseline lines | Allowed lines |
| -------------------------------------------------------- | -------------: | ------------: |
| `utils/oxcShaker.ts`                                     |          4,872 |         1,082 |
| `collectOxcTemplateDependencies/staticEvaluator.ts`      |          2,654 |         1,029 |
| `collectOxcTemplateDependencies/scopeAnalysis.ts`        |          1,647 |         1,000 |
| `collectOxcTemplateDependencies/expressionExtraction.ts` |          3,182 |         1,000 |

`bun run check:ts-size` fails for all four modules. Increasing the legacy
limits is explicitly out of scope.

The growth is not only structural. The same semantics are represented several
times:

- binding and assignment patterns;
- transparent runtime-expression wrappers;
- static property keys and member paths;
- lexical binding/reference resolution;
- mutation and escape timelines;
- destructuring projections and receiver effects;
- concrete and abstract static values.

This creates correctness drift, makes new syntax expensive to support, and
repeats work at transform time.

## Design principles

1. Share syntax and immutable program facts, not final policy decisions.
2. Preserve separate execution policies:
   - scope analysis is conservative over relevant syntax;
   - the shaker follows module-executed code and reachable callables;
   - the evaluator may discharge effects through static proofs.
3. Model destructuring as ordered operations, not as a property-path shortcut.
4. Keep hot dispatch explicit and typed. Do not replace every branch with
   allocation-heavy generic callbacks.
5. Every semantic migration needs characterization tests and a performance
   comparison against `9baff607`.
6. No production TypeScript file may exceed 1,000 lines unless its existing
   legacy limit is already lower and remains unchanged.

## Target dependency shape

```text
utils/oxc/ast.ts
  ├─ runtimeSemantics.ts
  ├─ patterns.ts
  ├─ projections.ts
  └─ bindingIndex.ts
       └─ collectOxcTemplateDependencies/mutationAnalysis.ts
            ├─ static evaluation
            └─ expression extraction

oxcShaker/
  ├─ executableIndex.ts
  ├─ effectEvents.ts
  ├─ patternEffects.ts
  ├─ statementGraph.ts
  └─ rewrite.ts
```

The shaker may consume shared AST, pattern, projection, and lexical facts, but
retains its own selected-export liveness and module-execution policy.

## Shared primitives

### Runtime AST semantics

Canonical helpers under `utils/oxc/`:

```ts
unwrapOxcRuntimeExpression(node, policy);
isOxcFunctionLike(node);
classifyOxcPropertyKey(key, computed);
decomposeOxcMemberPath(node, policy);
```

Runtime-child classification must distinguish transparent TypeScript
expression wrappers from type-only subtrees. An ancestor-wide
`node.type.startsWith('TS')` check is insufficient.

### Lexical scope traversal

`utils/oxc/lexicalScopes.ts` owns the syntax-level scope boundaries, runtime
reference classification, decorator routing, and TypeScript runtime/type-only
traversal shared by scope analysis and the shaker. Consumers still own their
binding records and policy. Both consumers collect declarations and deferred
references in one AST pass; the shared layer does not build a `Node -> Scope`
index.

### Pattern facts

The first safe representation records raw, time-independent syntax, but keeps
binding patterns and assignment targets as separate grammars. M1 introduces
only binding-pattern facts:

```ts
type BindingPatternFact =
  | { kind: 'binding'; identifier: Identifier; order: number }
  | { kind: 'computed-key'; expression: Expression; order: number }
  | { kind: 'default'; expression: Expression; order: number }
  | { kind: 'rest'; node: RestElement; order: number };
```

Those facts preserve:

- source order and duplicate bindings;
- array elisions;
- computed keys and defaults;
- `TSParameterProperty`;
- nested rest metadata.

Assignment-target facts are a separate M5 input because evaluating a target
may itself perform observable reference evaluation. They must preserve
duplicate targets and write order without treating target identifiers as
declarations.

Facts may be cached by pattern AST node. Resolved bindings, evaluated property
keys, and mutation-sensitive conclusions must not be cached in this layer.

### Structured projection paths

Property paths use structured segments, never dot-joined strings:

```ts
type ProjectionPath = {
  root: BindingId | UnresolvedName;
  segments: readonly PropertyKeyPart[];
};
```

This must distinguish `object["a.b"]` from `object.a.b` and preserve the
difference between numeric and string keys until a consumer deliberately
normalizes them.

### Binding and mutation indexes

```ts
interface BindingIndex {
  bindingOf(identifier: Identifier): BindingId | undefined;
  resolveAt(name: string, offset: number): BindingId | undefined;
  runtimeReferencesIn(node: Node): readonly Reference[];
  freeRuntimeReferencesIn(node: Node): readonly Reference[];
}

interface MutationIndex {
  changesOf(binding: BindingId): readonly ChangeEvent[];
  hasChange(binding: BindingId, range: ProgramRange): boolean;
  referencedExpressionChanged(
    expression: Node,
    range: ProgramRange,
    filter?: ChangeFilter
  ): boolean;
}
```

Purity classification remains caller-supplied to avoid a dependency cycle
from mutation analysis back into static evaluation.

## Ordered PatternProgram

The deeper representation compiles destructuring into ordered operations:

```ts
type PatternOp =
  | { op: 'evaluate-key'; expression: Expression }
  | { op: 'get'; key: PropertyKeySpec }
  | { op: 'iterate-next'; index: number }
  | { op: 'default'; expression: Expression }
  | { op: 'object-rest'; excluded: readonly PropertyKeySpec[] }
  | { op: 'array-rest' }
  | { op: 'bind'; target: BindingTarget }
  | { op: 'assign'; target: AssignmentTarget };
```

Consumers interpret the same program differently:

- scope analysis derives binding, runtime-expression, and alias facts;
- static evaluation executes it against concrete values;
- expression extraction derives static candidates and snapshot plans;
- the shaker derives receiver effects, provenance, and abruptness.

The program must preserve computed-key/default evaluation order, TDZ,
iterator consumption and closing, object-rest `CopyDataProperties` behavior,
symbols, getters, proxies, target multiplicity, and write order.

## Static evaluation outcome

Concrete evaluation must stop using JavaScript `undefined` for both a known
value and analysis failure:

```ts
type EvalOutcome<T = unknown> =
  | { kind: 'known'; value: T }
  | { kind: 'unknown'; reason: UnknownReason }
  | { kind: 'abrupt'; reason: AbruptReason };
```

The public compatibility adapter may continue returning `unknown | undefined`
until all callers migrate. The internal representation should use compact
singletons or tags if allocating outcome objects regresses the hot path.

## Expression planning

Expression extraction becomes a two-stage pipeline:

```ts
type ReferencePlan =
  | { kind: 'static-import'; import: StaticImport }
  | { kind: 'constant'; replacement: string }
  | { kind: 'static-local'; candidate: StaticLocalPlan }
  | { kind: 'processor-managed' }
  | { kind: 'snapshot'; binding: BindingId }
  | { kind: 'hoisted'; binding: BindingId }
  | { kind: 'reject'; reason: ExtractionFailure };
```

Planning is immutable. Name allocation, replacements, hoists, and source
generation belong to a separate emitter.

## Optimization backlog

The structural split exposed several independent performance opportunities.
They are deliberately tracked as separate slices so each change can be
benchmarked against its immediate parent and reverted without coupling it to a
semantic migration.

| ID  | Area                  | Optimization                                                                                                                                             | Expected benefit                                                                                                         | Risk and constraints                                                                                                                |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| O1  | shaker effects        | Remove the full `statements` scan from `bindingEffectsBefore`; direct mutations are already present in the strictly richer `effectsByBinding` index.     | High for member/receiver-heavy modules; removes an avoidable statement-count multiplier.                                 | Low. Preserve the existing alias-component and source-position filters.                                                             |
| O2  | extraction            | Memoize `requiresSnapshotReplay(binding)` for one `extractExpression` invocation.                                                                        | High when one expression repeats local bindings or has destructuring dependency fanout.                                  | Low. The cache must not cross expressions because `currentExpressionStart` changes, and exception/pass order must remain unchanged. |
| O3  | graph queues          | Replace FIFO `Array.shift()` loops in statement liveness and snapshot replay with monotonically increasing head indexes.                                 | Medium for long dependency closures; removes quadratic array compaction.                                                 | Very low. Preserve the existing statement-before-binding queue priority.                                                            |
| O4  | static calls          | Cache immutable function-body facts such as hoisted `var` names and top-level lexical/function declarations by function AST node.                        | High for repeated calls to one local function.                                                                           | Low if only syntax facts are cached. Environment writes and function values remain per invocation.                                  |
| O5  | purity proofs         | Cache completed `isKnownPureStaticCall` results and stop cloning the complete mutation-hazard map for every proof.                                       | High for hazard-heavy evaluation.                                                                                        | Medium. Recursive proofs need an explicit in-progress state and must fail closed; do not cache context-sensitive partial results.   |
| O6  | mutation queries      | Store sorted mutation/hazard timelines and expose allocation-free `someBefore`, `before`, and `between` range queries using binary search.               | High for snapshot and evaluator workloads with many changes; removes repeated `filter`, `sort`, and linear prefix scans. | Medium. Start-based and end-based predicates are not interchangeable and need characterization tests.                               |
| O7  | alias propagation     | Replace repeated whole-graph fixed-point scans with an indexed worklist keyed by newly added mutation/hazard events and reverse alias adjacency.         | High for long alias chains and fanout.                                                                                   | Medium. Preserve unknown-alias and sibling-import propagation exactly and process each newly discovered fact once.                  |
| O8  | callable analysis     | Cache immutable per-`CallableNode` syntax facts: assignments, direct/nested mutations, callee candidates, and local callable/class/accessor catalogs.    | High for repeated reachable call sites.                                                                                  | Medium. Caller aliases and invocation-sensitive facts must remain per invocation.                                                   |
| O9  | callable result paths | Index callable result paths by root/prefix instead of scanning every recorded path for each descendant query.                                            | Medium to high for large returned object graphs.                                                                         | Medium. Structured path equality and descendant semantics must remain collision-free.                                               |
| O10 | bindings              | Introduce canonical `BindingId`s, a resolved-reference index, and cached binding identities/mutation keys.                                               | Medium and broad; removes repeated string construction and repeated name/scope resolution.                               | Medium due to breadth. Land after range-query APIs establish the required consumers.                                                |
| O11 | provenance collectors | Convert recursive set-returning value/provenance collectors to caller-owned sinks or append APIs, and share only policy-neutral value-forwarding syntax. | Medium allocation and code-size reduction.                                                                               | Medium. Assignment operators, projections, alias policy, and abruptness remain consumer-owned; avoid callback-heavy hot dispatch.   |
| O12 | export ownership      | Pre-index collected exports by top-level statement instead of scanning all exports for every ordinary statement.                                         | Medium for modules with many statements and exports.                                                                     | Low to medium. Preserve re-export, default, and source-span ownership behavior.                                                     |
| O13 | reference collection  | Reuse a local `findReferences` cache throughout mutation/escape analysis instead of traversing the same expression once per proof.                       | Medium on nested alias expressions.                                                                                      | Low. Cache only immutable syntax-level references.                                                                                  |
| O14 | recursion guards      | Replace copied `Set` guards in recursive receiver/provenance proofs with backtracked mutable guards or numeric visit epochs.                             | Small to medium allocation reduction on deep graphs.                                                                     | Medium. Sibling branches must not leak visited state.                                                                               |

The larger `PatternProgram`, `EvalOutcome`, explicit snapshot abstract domain,
and extraction plan/emitter split remain architecture and correctness work.
They may unlock later optimization, but they are not treated as performance
wins without focused measurements. In particular, `PatternProgram` remains
blocked on the complete assignment-target evaluation schedule.

### Optimization order

1. Land O1, O3, and O2 as isolated low-risk slices.
2. Land the syntax-only caches O4 and O13.
3. Introduce O6 before O7 so the worklist publishes canonical timeline facts.
4. Measure O5 and O8 independently on hazard-heavy and callable-fanout
   fixtures.
5. Use O10 as the typed foundation for O9 and the later `PatternProgram`
   migration.
6. Attempt O11, O12, and O14 only with focused profiles showing that their
   allocation or lookup patterns are material.

Completed optimization slices:

- [x] O1: indexed-only shaker effect lookup (`a476c176`).
- [x] O2: per-expression snapshot decision memoization (`a476c176`).
- [x] O3: cursor-based shaker and snapshot replay queues (`a476c176`).

Every optimization must preserve generated output, CSS bytes/file counts,
evaluation counts, and existing fail-closed behavior. Performance comparisons
use paired alternating processes, track shaker/evaluator/preevaluation spans
separately from wall time, and record peak RSS for changes that add persistent
indexes or caches.

## Milestones

### M0 — Characterization and baseline

- [x] Add runtime-reference coverage for transparent TypeScript wrappers.
- [x] Add duplicate assignment-target coverage such as `[x, x] = value`.
- [x] Add computed-key/default ordering coverage. The full snapshot replay
      case is a pending `todo` until the ordered `PatternProgram` replaces
      first-match projection routing.
- [x] Add structured-key coverage for `a["b.c"]` versus `a.b.c`.
- [x] Record correctness and large-scenario performance baseline at
      `9baff607`.

### M1 — Shared syntax primitives (in progress)

- [x] Reuse canonical `isOxcNode` and `getOxcNodeChildren`.
- [x] Add runtime-wrapper and function-like helpers.
- [x] Add lazy cached raw binding-pattern facts.
- [x] Add duplicate-preserving assignment-target leaf traversal shared by the
      shaker, mutation analysis, snapshot replay, safety, and replacements.
- [ ] Add the complete assignment-target evaluation schedule, including
      computed-key/default and reference-evaluation order, before compiling the
      shared `PatternProgram`.
- [x] Add structured syntactic projection paths.
- [x] Migrate duplicate collectors in scope analysis, static evaluation,
      expression extraction, and the shaker.

### M2 — Structural split and size gate

- [x] Split lexical binding/reference traversal, binding resolution, and
      mutation analysis.
- [x] Split static host values from the concrete evaluator.
- [x] Split static safety proofs from the concrete evaluator.
- [x] Split pattern execution, mutation replay, function calls, conversions,
      and binary operations from the concrete evaluator.
- [ ] Split the remaining evaluator dispatch/purity SCC only if it can be done
      without an import cycle or extra calls on the identifier hot path.
- [x] Split snapshot abstract-value analysis from expression extraction.
- [x] Split static-local planning and snapshot replay from expression
      extraction.
- [ ] Split the remaining extraction emission only if it forms a cohesive
      leaf instead of a callback-heavy context object.
- [x] Split shaker pattern/receiver safety proofs.
- [x] Split shaker executable discovery and binding provenance.
- [x] Split shaker module rewriting, effect collection, and statement
      liveness.
- [x] Make `bun run check:ts-size` pass without increasing limits.

### M3 — Typed program facts

- [ ] Introduce `BindingId` and one binding/reference index.
- [ ] Introduce typed mutation/escape/receiver events.
- [ ] Add sorted mutation timelines and range queries.
- [ ] Replace magic unknown-binding strings with an explicit unknown
      provenance value.

### M4 — Evaluation and extraction plans

- [ ] Introduce internal `EvalOutcome`.
- [ ] Centralize callable and intrinsic resolution.
- [ ] Split extraction planning from source emission.
- [ ] Replace the snapshot string lattice with an explicit abstract domain.

### M5 — PatternProgram and provenance solver

- [ ] Compile ordered `PatternProgram`s and cache raw programs by AST node.
- [ ] Migrate the evaluator, extractor, and shaker interpreters.
- [ ] Introduce an indexed worklist for alias/effect propagation.
- [ ] Evaluate replacing recursive callable provenance with bounded monotone
      summaries.

## Acceptance gates

### Correctness

- Full `packages/transform/src` test suite passes.
- Existing issue #366 coverage remains green.
- New wrapper, order, duplicate-target, rest, iterator, getter, proxy, and
  structured-key characterization tests pass.
- Generated CSS, file counts, and evaluation counts remain unchanged in the
  performance fixtures.

### Static checks

- `bun run --filter @wyw-in-js/transform build:types`
- `bun run --filter @wyw-in-js/transform lint`
- `bun run check:ts-size`
- Prettier and `git diff --check`

### Performance

- Compare every semantic milestone with `9baff607` using paired, alternating
  large-scenario runs.
- Investigate any repeatable whole-transform regression above 5%.
- Track shaker and pre-evaluation spans separately from noisy `evalFile`
  timing.
- Do not add per-node allocation-heavy abstractions without a focused
  benchmark.

## Non-goals for the first wave

- A universal solver shared by scope invalidation and shaker liveness.
- Increasing production file-size allowances.
- Supporting new JavaScript syntax beyond the issue #366 contract.
- Rewriting import/export source editing.
- Changing public transform APIs or generated output.

## Progress log

### 2026-07-30

- Completed read-only architecture audit of the four expanded modules.
- Confirmed `check:ts-size` failures in all four modules.
- Identified exact duplicate pattern-runtime-expression walkers.
- Identified runtime-reference drift for transparent TypeScript wrappers.
- Identified dotted-string member-path collisions in the shaker.
- Identified known-`undefined` versus unknown-result conflation in static
  evaluation.
- Added shared runtime-expression, pattern, and structured-projection
  primitives under `utils/oxc/`.
- Removed the duplicated binding/runtime-expression collectors from all four
  target modules. The four files dropped from 12,355 to 12,078 lines before
  the later structural split.
- Fixed scope analysis for runtime references nested under transparent
  TypeScript wrappers; the focused hazard suite now passes 78/78.
- Replaced shaker dot-joined provenance keys with structured paths and a
  collision-free length-prefixed map key; the focused shaker suite passes
  142/142, including `box["a.b"]` versus `box.a.b`.
- Preserved duplicate target writes in snapshot replay. Recorded nested
  computed-key/default ordering as a pending test for the `PatternProgram`
  milestone rather than weakening the current fail-closed behavior.
- Verified the first slice with 1,356 passing transform tests, zero failures,
  type-check, lint, Prettier, and `git diff --check`.
- Ran paired alternating medium performance scenarios against `9baff607`.
  No repeatable whole-transform regression exceeded the 5% investigation
  threshold; the required large-profile gate remains pending.
- Started M2 by moving literal serialization, defensive cloning, descriptor
  reads, and plain receiver/projection checks into `staticValues.ts`.
  `staticEvaluator.ts` dropped from 2,554 to 2,104 lines without introducing a
  reverse dependency on the evaluator.
- Moved shaker receiver and pattern-abruptness proofs into
  `oxcShaker/patternEffects.ts`; `oxcShaker.ts` dropped from 4,858 to 4,441
  lines.
- Moved lexical traversal, binding resolution, and mutation/alias propagation
  into `scopeTraversal.ts`, `bindingResolution.ts`, and `mutationAnalysis.ts`.
  `scopeAnalysis.ts` dropped from 1,617 to 392 lines and now passes its
  production-size guard.
- Moved snapshot abstract-value inference into `snapshotValueAnalysis.ts`;
  `expressionExtraction.ts` dropped from 3,049 to 2,313 lines. Removed a
  duplicate recursive RHS inference from alias-mutation analysis.
- Reused the shared runtime-expression unwrapping policy without allocating an
  options object per call, and replaced the snapshot-specific wrapper chain
  with the common implementation.
- Moved intrinsic, binding, pattern-stability, and deterministic-undefined
  safety proofs into `staticEvaluationSafety.ts`; `staticEvaluator.ts` is now
  1,707 lines.
- Verified the combined structural slices with 1,356 passing transform tests,
  one skip, one pre-existing todo, zero failures, type-check, lint, Prettier,
  and two independent read-only reviews.
- Moved executable-node indexing and free-reference collection into
  `oxcShaker/executableIndex.ts`; moved binding aliases, callable/accessor
  catalogs, and class provenance into `oxcShaker/bindingProvenance.ts`.
  `oxcShaker.ts` dropped from 4,441 to 3,060 lines across those slices.
- Moved snapshot replay and static-local planning into `snapshotReplay.ts` and
  `staticLocalPlanning.ts`. `expressionExtraction.ts` dropped from 2,313 to
  995 lines and now passes its production-size guard.
- Moved pattern execution, root-mutation replay, local function execution,
  conversions, and binary operations into `staticEvaluationRuntime.ts`.
  `staticEvaluator.ts` dropped from 1,707 to 1,020 lines and now passes its
  legacy size guard; the runtime leaf is 828 lines.
- Preserved the evaluator/purity strongly connected component in
  `staticEvaluator.ts`. The runtime split adds no evaluator invocation,
  callback allocation, wrapper, or reverse import; the 18 callback edges use
  stable top-level function references.
- Re-ran the complete transform suite after the combined splits: 1,356 pass,
  one skip, one pre-existing todo, and zero failures.
- Ran 30 paired, alternating large
  `shared-constants-functional-fanout` samples per side against `9baff607`.
  Trimmed-mean deltas were -0.01% wall, -2.15% evaluator, and +0.48% preeval,
  with no repeatable regression above the 5% investigation threshold.
- Moved import/export rewriting and parse/generate fallbacks into
  `oxcShaker/moduleRewrites.ts` (577 lines).
- Moved callable, class, alias, and receiver provenance into
  `oxcShaker/callableProvenanceIndex.ts` (963 lines). The index is built once
  per shake rather than recreating its helper closures for every candidate
  statement.
- Moved statement ownership and liveness propagation into
  `oxcShaker/statementGraph.ts` (612 lines), and module-invocation effect
  collection into `oxcShaker/moduleInvocationEffects.ts` (978 lines).
  `oxcShaker.ts` is now a two-line public facade over a direct acyclic import
  graph; the temporary factory/callback boundary was removed.
- Added characterization coverage for prototype mutation isolation, recursive
  compound callees with an independent sibling, and guarded class
  construction cycles. The focused shaker suite passes 146/146.
- Re-ran the complete transform suite on the final graph: 1,360 pass, one
  skip, one pre-existing todo, and zero failures. Type build, full transform
  lint, Prettier, `git diff --check`, and the global TypeScript size guard all
  pass without increasing a limit.
- Ran six alternating large benchmark pairs against `9baff607`, with three
  measured samples after one warmup in each process. Across 18 samples per
  side, trimmed-mean deltas were -0.14% wall, -0.12% evaluator, and +1.77%
  preeval; wall medians differed by +1.59%.
- Recorded peak RSS for each of the same 12 benchmark processes. Current
  versus baseline RSS differed by +0.99% in the mean and +0.15% in the median.
  Both time and memory results remain below the 5% investigation threshold.
- Added the shared lexical traversal in `459dbba5`. It separates function
  parameter and body environments, routes decorators and switch discriminants
  through the correct scopes, and records exact reference scopes for binding
  resolution. The same slice fixed initializer-free `var` redeclarations so
  they no longer overwrite same-name parameters.
- Replaced the shape-dependent OXC child-key cache with the parser's canonical
  visitor keys. This removed an order-dependent JS-then-TS decorator failure.
  Against `f3378291`, the 480-declaration `analyzeProgram` microbenchmark
  improved from 212.6 ms to 149.0 ms in the aggregate mean (-29.9%).
- Migrated shaker reference collection to the lexical kernel in `1b4c6c63`
  without reintroducing a second AST pass or a `Node -> Scope` map.
  `executableIndex.ts` dropped from 648 to 485 lines. Differential review over
  37 programs, 576 subtree roots, and 356 repository TypeScript files found no
  unexpected reference changes; only declaration-only destructuring names
  stopped being reported as module references.
- The paired large-profile gate for `1b4c6c63` versus `459dbba5` used 16
  samples per side. Trimmed deltas were +0.52% wall, +0.33% evaluator, +1.01%
  preevaluation, and +0.31% eval-file time, with identical CSS bytes, CSS file
  counts, and evaluation counts.
- Added the zero-callback assignment-target kernel in `72b17110` and migrated
  five consumers. It preserves duplicates and source order while leaving
  binding, member, unknown-alias, and safety policy with each consumer.
  Production code in this slice decreased by 64 lines; the complete transform
  suite passed 1,395 tests.
- Added the zero-allocation syntactic property-key fast path in `cfc96b02`.
  Five consumers now share scalar identifier/literal classification while
  retaining dynamic evaluation and `Symbol.iterator` policy. Across 20 paired
  large samples per side, trimmed deltas versus `72b17110` were -3.19% wall,
  -4.01% evaluator, and -2.38% preevaluation; generated outputs and counts were
  unchanged. The complete transform suite passed 1,396 tests.
- Combined RSS for the assignment-target and property-key slices versus
  `1b4c6c63` was -0.36% in the mean and +1.80% in the median across three
  processes per side. From `f3378291` through `cfc96b02`, production
  TypeScript decreased by 27 lines overall while the shared lexical and
  assignment-target kernels replaced the duplicated implementations.

### 2026-07-31

- Recorded fourteen independent optimization vectors, their semantic
  constraints, benchmark shapes, and implementation order.
- Landed O1, O2, and O3 in `a476c176`: removed the redundant all-statement
  shaker effect scan, replaced four FIFO `shift()` calls with cursor queues,
  and added a reusable binding-fact memoizer scoped to one extracted
  expression.
- Ran five fresh-process ABBA blocks against `30fc5f72` for each focused
  benchmark, with 200 measured samples per side. The 800-pair member-heavy
  shaker profile improved from 35.235 ms to 10.559 ms in the 10% trimmed mean
  (-70.03%); medians improved from 36.656 ms to 10.461 ms (-71.46%).
- The 512-reference, 32-alias snapshot profile improved from 10.544 ms to
  8.568 ms in the 10% trimmed mean (-18.74%); medians improved from 10.474 ms
  to 8.542 ms (-18.45%). Baseline and candidate output hashes and result counts
  were identical in both focused profiles.
- Ran two large ABBA blocks of `shared-constants-functional-fanout`, producing
  20 samples per side. Trimmed-mean deltas were -2.00% wall, -1.05% evaluator,
  -1.33% preevaluation, and -2.16% eval-file time. CSS bytes, CSS file counts,
  and every recorded method count were identical.
- Verified the implementation with 1,396 passing transform tests, one skip,
  one existing todo, and zero failures. Type build, full transform lint,
  Prettier, `git diff --check`, and the global TypeScript size guard pass;
  `expressionExtraction.ts` remains below its unchanged limit at 998 lines.
