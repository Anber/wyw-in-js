# TASK-12: Verification, Perf, and Cleanup

Status: done

## Goal

Run final verification, collect perf, and close out task statuses/logs.

## Files

- `PLAN.md`
- `PLAN.tasks/*.md`
- Any touched source/test files that need final cleanup.

## Checklist

- [x] Run targeted transform tests.
- [x] Run processor-utils tests.
- [x] Run transform and processor-utils type builds.
- [x] Run root validation/perf with Portal/Darkmatter static strategy, or record an explicit blocker.
- [x] Confirm production `.ts` files are below 1000 lines.
- [x] Update task statuses and last verification.
- [x] Remove accidental debug artifacts.
- [x] Prepare final summary.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.
- 2026-05-08 16:27 EEST: Started final verification after Task 11 commit `0b44adad`.
- 2026-05-08 16:31 EEST: Full root `./validate.sh` failed at Portal CSS hash compare. The diff only replaced `app/build/assets/useStateService-BCxrRI6a.css` hash `18141f4f...` with `app/build/assets/useStateService-CxMNIz9f.css` hash `406b1e87...`; investigating whether this is a real CSS delta or an unstable asset hash.
- 2026-05-08 16:34 EEST: Targeted transform tests passed: `bun test src/__tests__/applyOxcProcessors.test.ts src/__tests__/collectOxcTemplateDependencies.test.ts src/__tests__/oxc-preeval-stage.test.ts src/__tests__/oxc-collect-runtime.test.ts src/__tests__/transform.static-import-values.test.ts src/__tests__/resolveStaticOxcValues.boundary.test.ts` reported 127 passing tests.
- 2026-05-08 16:34 EEST: Processor-utils tests passed: `bun test src` reported 12 passing tests.
- 2026-05-08 16:34 EEST: Type, lint, and file-size checks passed: `bun run --filter @wyw-in-js/transform build:types`, `bun run --filter @wyw-in-js/processor-utils build:types`, `bun run --filter @wyw-in-js/transform lint`, `bun run --filter @wyw-in-js/processor-utils lint`, `bun run lint:scripts`, and `bun run check:ts-size`.
- 2026-05-08 16:34 EEST: The Portal CSS hash from the failed root validation matches the earlier `validate-baselines/perf-labels-hoc-20260508-r1` snapshot, and the Portal checkout already has unrelated local modifications. Perf was not run because the validation workflow requires a clean root validation pass first. No tracked build/debug artifacts were produced in `wyw-in-js`.

## Context Recovery Notes

Final validation output is known. The remaining blocker is outside `wyw-in-js`: reconcile the root Portal CSS baseline or rerun validation from a clean Portal checkout before collecting perf.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/applyOxcProcessors.test.ts src/__tests__/collectOxcTemplateDependencies.test.ts src/__tests__/oxc-preeval-stage.test.ts src/__tests__/oxc-collect-runtime.test.ts src/__tests__/transform.static-import-values.test.ts`
- `cd wyw-in-js/packages/processor-utils && bun test src`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform build:types && bun run --filter @wyw-in-js/processor-utils build:types`
- Root validation/perf command from the active validation workflow.

## Done Criteria

- Tests and type builds have recorded results.
- Perf run has recorded results or an explicit blocker.
- Plan/task files reflect final state.
