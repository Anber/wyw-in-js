# TASK-04: Split collectOxcTemplateDependencies

Status: done

## Goal

Split `collectOxcTemplateDependencies.ts` into focused modules while keeping its exported API stable.

## Files

- `packages/transform/src/utils/collectOxcTemplateDependencies.ts`
- New modules under `packages/transform/src/utils/collectOxcTemplateDependencies/`

## Checklist

- [x] Identify public exports and internal responsibilities.
- [x] Extract bindings/scope analysis.
- [x] Extract evaluator logic.
- [x] Extract expression dependency collection.
- [x] Extract static binding helpers.
- [x] Leave the original file as a small facade.
- [x] Confirm production `.ts` files are below 1000 lines where this task touches them.
- [x] Run focused tests.
- [x] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.
- 2026-05-08 15:17 EEST: Started task after committing shared Oxc utilities. Inspecting top-level structure and dependency direction before moving code.
- 2026-05-08 15:37 EEST: Split the module into `types`, `staticBindings`, `scopeAnalysis`, `staticEvaluator`, `expressionReplacements`, and `expressionExtraction`. Kept `collectOxcTemplateDependencies.ts` as a facade.
- 2026-05-08 15:43 EEST: Verified split with focused tests, transform type build, transform lint, size guard, and script lint. Removed `collectOxcTemplateDependencies.ts` from the legacy size allowlist because the facade and new modules are under 1000 lines.

## Context Recovery Notes

Keep call sites unchanged unless a local import path update is required. This task should not add the new processor static contract yet.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/collectOxcTemplateDependencies.test.ts src/__tests__/transform.static-import-values.test.ts`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform build:types`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform lint`
- `cd wyw-in-js && bun run check:ts-size`
- `cd wyw-in-js && bun run lint:scripts`

## Done Criteria

- Original file is a facade below 1000 lines.
- Extracted modules have clear ownership and focused tests still pass.
