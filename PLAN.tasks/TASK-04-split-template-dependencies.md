# TASK-04: Split collectOxcTemplateDependencies

Status: pending

## Goal

Split `collectOxcTemplateDependencies.ts` into focused modules while keeping its exported API stable.

## Files

- `packages/transform/src/utils/collectOxcTemplateDependencies.ts`
- New modules under `packages/transform/src/utils/collectOxcTemplateDependencies/`

## Checklist

- [ ] Identify public exports and internal responsibilities.
- [ ] Extract bindings/scope analysis.
- [ ] Extract evaluator logic.
- [ ] Extract expression dependency collection.
- [ ] Extract static binding helpers.
- [ ] Leave the original file as a small facade.
- [ ] Confirm production `.ts` files are below 1000 lines where this task touches them.
- [ ] Run focused tests.
- [ ] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.

## Context Recovery Notes

Keep call sites unchanged unless a local import path update is required. This task should not add the new processor static contract yet.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/collectOxcTemplateDependencies.test.ts src/__tests__/transform.static-import-values.test.ts`

## Done Criteria

- Original file is a facade below 1000 lines.
- Extracted modules have clear ownership and focused tests still pass.
