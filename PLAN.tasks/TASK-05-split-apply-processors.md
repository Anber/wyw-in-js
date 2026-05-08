# TASK-05: Split applyOxcProcessors

Status: done

## Goal

Split `applyOxcProcessors.ts` into discovery, usage collection, processor instantiation, cleanup, and same-file static value modules while preserving the same exported API.

## Files

- `packages/transform/src/utils/applyOxcProcessors.ts`
- New modules under `packages/transform/src/utils/applyOxcProcessors/`

## Checklist

- [x] Identify facade exports and local types.
- [x] Extract processor discovery.
- [x] Extract usage collection.
- [x] Extract processor instantiation.
- [x] Extract cleanup/removal logic.
- [x] Extract same-file static values logic.
- [x] Keep the facade below 1000 lines.
- [x] Run focused tests.
- [x] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.
- 2026-05-08 15:46 EEST: Started task after splitting template dependency collection. Inspecting `applyOxcProcessors` top-level responsibilities before extracting modules.
- 2026-05-08 16:10 EEST: Split `applyOxcProcessors` into facade plus modules for cleanup bindings/removals, processor usages, expression values, display-name/reference handling, same-file static values, processor factory, shared source helpers, and types.
- 2026-05-08 16:16 EEST: Verified focused tests, transform type build, transform lint, size guard, and script lint. Removed `applyOxcProcessors.ts` from the legacy size allowlist because the facade and extracted modules are below 1000 lines.

## Context Recovery Notes

This task is structural. Do not move Linaria-specific static heuristics yet unless they are part of current `applyOxcProcessors` ownership and can be preserved exactly.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/applyOxcProcessors.test.ts src/__tests__/transform.static-import-values.test.ts`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform build:types`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform lint`
- `cd wyw-in-js && bun run check:ts-size`
- `cd wyw-in-js && bun run lint:scripts`

## Done Criteria

- Original file is a facade below 1000 lines.
- Extracted modules are named by responsibility.
- Tests pass.
