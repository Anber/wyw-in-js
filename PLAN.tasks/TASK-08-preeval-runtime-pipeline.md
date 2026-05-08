# TASK-08: Preeval and Runtime Pipeline

Status: pending

## Goal

Make `collectOxcRuntime.ts` and `oxcPreevalStage.ts` explicit pipeline facades that consume the new modules without changing strategy semantics.

## Files

- `packages/transform/src/utils/collectOxcRuntime.ts`
- `packages/transform/src/utils/oxcPreevalStage.ts`
- New pipeline modules as needed.

## Checklist

- [ ] Map current runtime collection and preeval stages.
- [ ] Extract named pipeline steps where it improves ownership.
- [ ] Keep strategy branching explicit and tested.
- [ ] Ensure `execute` bypasses static adapters.
- [ ] Ensure `hybrid` and `static` consume resolved static overlays at the right phase.
- [ ] Run focused tests.
- [ ] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.

## Context Recovery Notes

Do not reintroduce early static fallback assertions. `static` must fail only after the full static resolve pass.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/oxc-preeval-stage.test.ts src/__tests__/oxc-collect-runtime.test.ts src/__tests__/transform.static-import-values.test.ts`

## Done Criteria

- Runtime and preeval files read as pipeline facades.
- Strategy behavior remains characterized and passing.
