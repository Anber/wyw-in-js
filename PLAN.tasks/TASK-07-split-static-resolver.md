# TASK-07: Split Static Resolver and Processor Semantics

Status: pending

## Goal

Split `resolveStaticOxcValues.ts` and move processor-specific static semantics behind adapters built on the new processor contract.

## Files

- `packages/transform/src/transform/generators/resolveStaticOxcValues.ts`
- New modules under `packages/transform/src/transform/generators/resolveStaticOxcValues/`
- Static contract bridge modules under `packages/transform/src/utils` if needed.

## Checklist

- [ ] Identify current graph/cache/export/pruning/runtime-proof responsibilities.
- [ ] Extract graph and cache.
- [ ] Extract export resolver.
- [ ] Extract processor static model.
- [ ] Extract pruning.
- [ ] Extract opaque runtime proof.
- [ ] Keep legacy behavior while processor adapters are incomplete.
- [ ] Add tests proving `__wyw_meta.extends` is no longer hardcoded in core.
- [ ] Keep facade below 1000 lines.
- [ ] Run focused tests.
- [ ] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.

## Context Recovery Notes

The key outcome is ownership separation: core may carry generic value kinds, but Linaria-shaped metadata must be interpreted outside the static core.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/transform.static-import-values.test.ts src/__tests__/oxc-preeval-stage.test.ts`

## Done Criteria

- Static resolver is split into focused files.
- Processor-specific semantics are represented through adapter boundaries.
- Existing static/hybrid behavior remains covered.
