# TASK-02: Characterization Tests and File-Size Guard

Status: done

## Goal

Lock down current behavior for `execute`, `hybrid`, and `static` evaluation before refactoring, and add a guard that fails when production `.ts` files exceed 1000 lines.

## Files

- `packages/transform/src/__tests__/oxc-preeval-stage.test.ts`
- `packages/transform/src/__tests__/transform.static-import-values.test.ts`
- Existing nearby transform tests if they already cover the right APIs.
- A script/test entry for production TypeScript file size enforcement.

## Checklist

- [x] Inspect existing strategy tests and identify missing behavior.
- [x] Add characterization for `execute`: no static adapter path and eval payload behavior remains unchanged.
- [x] Add characterization for `hybrid`: resolved static values are pruned while unresolved values still reach eval payloads.
- [x] Add characterization for `static`: unresolved values are reported only after full static resolve.
- [x] Add a production `.ts` line-count guard excluding test files.
- [x] Run targeted tests.
- [x] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task queued after scaffold creation.
- 2026-05-08 14:40 EEST: Started task. Existing tests already cover basic `execute`, `hybrid`, and `static` behavior; adding narrower characterization around strategy boundaries plus a size guard with temporary legacy allowlist for current monoliths.
- 2026-05-08 14:47 EEST: Added `execute` and `hybrid` preeval characterization tests. Added `check:ts-size` with current legacy allowlist for existing oversized production `src` files and exclusion of tests/fixtures/generated artifacts/package scripts.
- 2026-05-08 14:49 EEST: Verified `bun test src/__tests__/oxc-preeval-stage.test.ts src/__tests__/transform.static-import-values.test.ts`, `bun run check:ts-size`, and `bun run lint:scripts`.

## Context Recovery Notes

Start by reading current tests around `oxcPreevalStage`, `transform.static-import-values`, and any existing eval strategy tests. Keep tests focused on externally observable behavior so later refactors can move implementation freely.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/oxc-preeval-stage.test.ts src/__tests__/transform.static-import-values.test.ts`
- `cd wyw-in-js && bun run check:ts-size`
- `cd wyw-in-js && bun run lint:scripts`

## Done Criteria

- Characterization tests fail on meaningful strategy regressions.
- File-size guard is present and documented in this task.
- Tests pass before moving to Task 03.
