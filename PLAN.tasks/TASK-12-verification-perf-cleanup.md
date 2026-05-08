# TASK-12: Verification, Perf, and Cleanup

Status: pending

## Goal

Run final verification, collect perf, and close out task statuses/logs.

## Files

- `PLAN.md`
- `PLAN.tasks/*.md`
- Any touched source/test files that need final cleanup.

## Checklist

- [ ] Run targeted transform tests.
- [ ] Run processor-utils tests.
- [ ] Run transform and processor-utils type builds.
- [ ] Run root validation/perf with Portal/Darkmatter static strategy.
- [ ] Confirm production `.ts` files are below 1000 lines.
- [ ] Update task statuses and last verification.
- [ ] Remove accidental debug artifacts.
- [ ] Prepare final summary.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.

## Context Recovery Notes

If final validation fails, add the failure and next action to this file before fixing. Do not mark the task done until verification output is known.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/applyOxcProcessors.test.ts src/__tests__/collectOxcTemplateDependencies.test.ts src/__tests__/oxc-preeval-stage.test.ts src/__tests__/oxc-collect-runtime.test.ts src/__tests__/transform.static-import-values.test.ts`
- `cd wyw-in-js/packages/processor-utils && bun test src`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform build:types && bun run --filter @wyw-in-js/processor-utils build:types`
- Root validation/perf command from the active validation workflow.

## Done Criteria

- Tests and type builds have recorded results.
- Perf run has recorded results or an explicit blocker.
- Plan/task files reflect final state.
