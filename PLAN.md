# Processor-Driven Static Evaluation Refactor

## Current State

- Branch: `anber/static-eval-architecture`
- Base branch: `anber/pr-312-static-imports-max`
- Base commit: `58c8143f9a9f1cf8d9fd55e3875d0af960efc841`
- Active task: `TASK-03-shared-oxc-utils.md`
- Blocking questions: none
- Last verification: `bun test src/__tests__/oxc-preeval-stage.test.ts src/__tests__/transform.static-import-values.test.ts` in `packages/transform`, `bun run check:ts-size`, and `bun run lint:scripts` passed on 2026-05-08.

## Working Rules

- Work one task at a time.
- Before and after substantial changes, update the active task's progress log.
- Keep this file's task index current.
- After context compaction, recover by reading this file, then the active task file, then `git status`.
- Each task should land as its own commit unless it is explicitly split into smaller safe commits.
- Production `.ts` files should stay at or below 1000 lines after the refactor. Tests are excluded from this limit.
- Preserve dynamic evaluation behavior:
  - `eval.strategy: "execute"` does not use static processor adapters.
  - `hybrid` only applies static overlay to proven values; unknown values stay in eval payloads.
  - `static` reports unresolved values after the full static resolve pass, not before.
  - The Linaria runtime/eval bridge keeps receiving legacy `__wyw_meta` shape where that shape is required.

## Task Index

| ID | Status | Task File | Goal |
| --- | --- | --- | --- |
| 01 | done | [PLAN.tasks/TASK-01-planning-scaffold.md](PLAN.tasks/TASK-01-planning-scaffold.md) | Create branch and task tracking scaffold. |
| 02 | done | [PLAN.tasks/TASK-02-characterization-tests.md](PLAN.tasks/TASK-02-characterization-tests.md) | Lock current strategy behavior and add file-size guard. |
| 03 | pending | [PLAN.tasks/TASK-03-shared-oxc-utils.md](PLAN.tasks/TASK-03-shared-oxc-utils.md) | Extract shared Oxc parsing, visiting, replacement, and location helpers. |
| 04 | pending | [PLAN.tasks/TASK-04-split-template-dependencies.md](PLAN.tasks/TASK-04-split-template-dependencies.md) | Split `collectOxcTemplateDependencies` behind the same public API. |
| 05 | pending | [PLAN.tasks/TASK-05-split-apply-processors.md](PLAN.tasks/TASK-05-split-apply-processors.md) | Split `applyOxcProcessors` behind the same public API. |
| 06 | pending | [PLAN.tasks/TASK-06-processor-static-contract.md](PLAN.tasks/TASK-06-processor-static-contract.md) | Add public optional processor static contract in `processor-utils`. |
| 07 | pending | [PLAN.tasks/TASK-07-split-static-resolver.md](PLAN.tasks/TASK-07-split-static-resolver.md) | Split static resolver and move processor-specific semantics behind adapters. |
| 08 | pending | [PLAN.tasks/TASK-08-preeval-runtime-pipeline.md](PLAN.tasks/TASK-08-preeval-runtime-pipeline.md) | Update preeval/runtime pipeline to consume the new modules. |
| 09 | pending | [PLAN.tasks/TASK-09-linaria-contract.md](PLAN.tasks/TASK-09-linaria-contract.md) | Implement the contract in Linaria styled/core/atomic processors. |
| 10 | pending | [PLAN.tasks/TASK-10-remove-core-heuristics.md](PLAN.tasks/TASK-10-remove-core-heuristics.md) | Remove old hardcoded static heuristics from transform core. |
| 11 | pending | [PLAN.tasks/TASK-11-changeset.md](PLAN.tasks/TASK-11-changeset.md) | Add a public changeset for the v2 processor static contract. |
| 12 | pending | [PLAN.tasks/TASK-12-verification-perf-cleanup.md](PLAN.tasks/TASK-12-verification-perf-cleanup.md) | Run verification, perf, and clean up statuses/logs. |

## Architecture Target

- Static core owns graph traversal, caching, debug output, fallback decisions, and unresolved reporting.
- Processors describe semantic meaning of values through a public optional v2 static contract.
- Transform core no longer directly knows Linaria-shaped `__wyw_meta.extends`, CSS artifacts, selector-only class names, or component wrapper semantics.
- Processor adapters translate processor/runtime metadata into static values:
  - `serializable`
  - `class-name`
  - `selector-chain`
  - `runtime-callback`
  - `opaque-component`
  - `unresolved`
- Existing public behavior remains default-compatible except for intentional v2 processor API additions.

## Target Verification

- `cd wyw-in-js/packages/transform && bun test src/__tests__/applyOxcProcessors.test.ts src/__tests__/collectOxcTemplateDependencies.test.ts src/__tests__/oxc-preeval-stage.test.ts src/__tests__/oxc-collect-runtime.test.ts src/__tests__/transform.static-import-values.test.ts`
- `cd wyw-in-js/packages/processor-utils && bun test src`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform build:types && bun run --filter @wyw-in-js/processor-utils build:types`
- Root validation/perf after integration with Portal/Darkmatter static strategy.
