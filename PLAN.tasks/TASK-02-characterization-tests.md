# TASK-02: Characterization Tests and File-Size Guard

Status: pending

## Goal

Lock down current behavior for `execute`, `hybrid`, and `static` evaluation before refactoring, and add a guard that fails when production `.ts` files exceed 1000 lines.

## Files

- `packages/transform/src/__tests__/oxc-preeval-stage.test.ts`
- `packages/transform/src/__tests__/transform.static-import-values.test.ts`
- Existing nearby transform tests if they already cover the right APIs.
- A script/test entry for production TypeScript file size enforcement.

## Checklist

- [ ] Inspect existing strategy tests and identify missing behavior.
- [ ] Add characterization for `execute`: no static adapter path and eval payload behavior remains unchanged.
- [ ] Add characterization for `hybrid`: resolved static values are pruned while unresolved values still reach eval payloads.
- [ ] Add characterization for `static`: unresolved values are reported only after full static resolve.
- [ ] Add a production `.ts` line-count guard excluding test files.
- [ ] Run targeted tests.
- [ ] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task queued after scaffold creation.

## Context Recovery Notes

Start by reading current tests around `oxcPreevalStage`, `transform.static-import-values`, and any existing eval strategy tests. Keep tests focused on externally observable behavior so later refactors can move implementation freely.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/oxc-preeval-stage.test.ts src/__tests__/transform.static-import-values.test.ts`
- File-size guard command to be added by this task.

## Done Criteria

- Characterization tests fail on meaningful strategy regressions.
- File-size guard is present and documented in this task.
- Tests pass before moving to Task 03.
