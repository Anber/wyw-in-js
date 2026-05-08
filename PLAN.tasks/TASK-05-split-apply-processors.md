# TASK-05: Split applyOxcProcessors

Status: pending

## Goal

Split `applyOxcProcessors.ts` into discovery, usage collection, processor instantiation, cleanup, and same-file static value modules while preserving the same exported API.

## Files

- `packages/transform/src/utils/applyOxcProcessors.ts`
- New modules under `packages/transform/src/utils/applyOxcProcessors/`

## Checklist

- [ ] Identify facade exports and local types.
- [ ] Extract processor discovery.
- [ ] Extract usage collection.
- [ ] Extract processor instantiation.
- [ ] Extract cleanup/removal logic.
- [ ] Extract same-file static values logic.
- [ ] Keep the facade below 1000 lines.
- [ ] Run focused tests.
- [ ] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.

## Context Recovery Notes

This task is structural. Do not move Linaria-specific static heuristics yet unless they are part of current `applyOxcProcessors` ownership and can be preserved exactly.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/applyOxcProcessors.test.ts src/__tests__/transform.static-import-values.test.ts`

## Done Criteria

- Original file is a facade below 1000 lines.
- Extracted modules are named by responsibility.
- Tests pass.
