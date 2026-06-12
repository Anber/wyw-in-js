# TASK-08: Preeval and Runtime Pipeline

Status: done

## Goal

Make `collectOxcRuntime.ts` and `oxcPreevalStage.ts` explicit pipeline facades that consume the new modules without changing strategy semantics.

## Files

- `packages/transform/src/utils/collectOxcRuntime.ts`
- `packages/transform/src/utils/oxcPreevalStage.ts`
- New pipeline modules as needed.

## Checklist

- [x] Map current runtime collection and preeval stages.
- [x] Extract named pipeline steps where it improves ownership.
- [x] Keep strategy branching explicit and tested.
- [x] Ensure `execute` bypasses static adapters.
- [x] Ensure `hybrid` and `static` consume resolved static overlays at the right phase.
- [x] Run focused tests.
- [x] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.
- 2026-05-08 16:14 EEST: Started Task 08. Current files are under the size limit; scope is ownership clarity for runtime normalization/source maps and preeval strategy/code-preparation steps.
- 2026-05-08 16:24 EEST: Split runtime normalization/source maps and preeval processor collection, strategy overlay, code preparation, and `__wywPreval` export into explicit modules. Focused tests, transform typecheck, lint, and size guard pass.

## Context Recovery Notes

Do not reintroduce early static fallback assertions. `static` must fail only after the full static resolve pass.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/oxc-preeval-stage.test.ts src/__tests__/oxc-collect-runtime.test.ts src/__tests__/transform.static-import-values.test.ts`

## Done Criteria

- Runtime and preeval files read as pipeline facades.
- Strategy behavior remains characterized and passing.
