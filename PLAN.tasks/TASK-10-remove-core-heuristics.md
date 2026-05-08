# TASK-10: Remove Core Static Heuristics

Status: pending

## Goal

Remove old hardcoded static heuristics from transform core once processor adapters cover the same behavior.

## Files

- `packages/transform/src/transform/generators/resolveStaticOxcValues.ts`
- Split static resolver modules.
- Any transform utility modules that still reference Linaria-specific metadata.

## Checklist

- [ ] Search for direct transform-core references to Linaria-shaped metadata such as `__wyw_meta.extends`.
- [ ] Remove selector-only className and CSS artifact special cases from core.
- [ ] Ensure core handles only generic static value kinds.
- [ ] Add or update tests that fail if core directly hardcodes Linaria metadata again.
- [ ] Run focused tests.
- [ ] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.

## Context Recovery Notes

This cleanup should happen after Linaria processors implement the contract; otherwise dynamic/static behavior may regress.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/transform.static-import-values.test.ts src/__tests__/oxc-preeval-stage.test.ts`

## Done Criteria

- Transform core has no direct Linaria-specific static semantics.
- Tests cover adapter ownership.
