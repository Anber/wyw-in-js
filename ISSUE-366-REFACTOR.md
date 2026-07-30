# Issue 366 OXC analysis refactor

## Status

- State: in progress
- Feature branch: `anber/fix-static-destructuring`
- Behavioral baseline: `9baff607f6121fc0d33db9119e2ce014d408834b`
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

## Milestones

### M0 — Characterization and baseline

- [x] Add runtime-reference coverage for transparent TypeScript wrappers.
- [x] Add duplicate assignment-target coverage such as `[x, x] = value`.
- [x] Add computed-key/default ordering coverage. The full snapshot replay
      case is a pending `todo` until the ordered `PatternProgram` replaces
      first-match projection routing.
- [x] Add structured-key coverage for `a["b.c"]` versus `a.b.c`.
- [ ] Record correctness and large-scenario performance baseline at
      `9baff607`.

### M1 — Shared syntax primitives (in progress)

- [x] Reuse canonical `isOxcNode` and `getOxcNodeChildren`.
- [x] Add runtime-wrapper and function-like helpers.
- [x] Add lazy cached raw binding-pattern facts.
- [ ] Add assignment-target facts with their distinct reference-evaluation
      order before compiling the shared `PatternProgram`.
- [x] Add structured syntactic projection paths.
- [x] Migrate duplicate collectors in scope analysis, static evaluation,
      expression extraction, and the shaker.

### M2 — Structural split and size gate

- [ ] Split lexical binding/reference indexing from mutation analysis.
- [x] Split static host values from the concrete evaluator.
- [ ] Split pattern execution, intrinsics, and evaluator dispatch.
- [ ] Split static-local planning, snapshot analysis, snapshot replay, and
      emission.
- [ ] Split shaker executable discovery, effect collection, pattern safety,
      statement liveness, and rewriting.
- [ ] Make `bun run check:ts-size` pass without increasing limits.

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
