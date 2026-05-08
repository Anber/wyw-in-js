# TASK-07: Split Static Resolver and Processor Semantics

Status: done

## Goal

Split `resolveStaticOxcValues.ts` and move processor-specific static semantics behind adapters built on the new processor contract.

## Files

- `packages/transform/src/transform/generators/resolveStaticOxcValues.ts`
- New modules under `packages/transform/src/transform/generators/resolveStaticOxcValues/`
- Static contract bridge modules under `packages/transform/src/utils` if needed.

## Checklist

- [x] Identify current graph/cache/export/pruning/runtime-proof responsibilities.
- [x] Extract graph and cache.
- [x] Extract export resolver.
- [x] Extract processor static model.
- [x] Extract pruning.
- [x] Extract opaque runtime proof.
- [x] Keep legacy behavior while processor adapters are incomplete.
- [x] Add tests proving `__wyw_meta.extends` is no longer hardcoded in core.
- [x] Keep facade below 1000 lines.
- [x] Run focused tests.
- [x] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.
- 2026-05-08 15:35 EEST: Started Task 07. Recovering current resolver responsibilities before extracting modules.
- 2026-05-08 15:42 EEST: Responsibility map: cache/debug, static expression/import helpers, pruning, program analysis, dependency walker, processor static adapter, object-assign handling, opaque runtime proof, export/candidate resolvers, and preeval pipeline facade.
- 2026-05-08 16:02 EEST: Split `resolveStaticOxcValues` into focused modules under `resolveStaticOxcValues/`; `bun run --filter @wyw-in-js/transform build:types` passes after import boundary fixes.
- 2026-05-08 16:13 EEST: Added boundary test keeping `__wyw_meta` interpretation inside `processorStaticModel`, removed the resolver legacy size allowlist, and verified typecheck, lint, size guard, script lint, and focused tests.

## Context Recovery Notes

The key outcome is ownership separation: core may carry generic value kinds, but Linaria-shaped metadata must be interpreted outside the static core.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/transform.static-import-values.test.ts src/__tests__/oxc-preeval-stage.test.ts`

## Done Criteria

- Static resolver is split into focused files.
- Processor-specific semantics are represented through adapter boundaries.
- Existing static/hybrid behavior remains covered.
