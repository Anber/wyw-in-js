# TASK-10: Remove Core Static Heuristics

Status: done

## Goal

Remove old hardcoded static heuristics from transform core once processor adapters cover the same behavior.

## Files

- `packages/transform/src/transform/generators/resolveStaticOxcValues.ts`
- Split static resolver modules.
- Any transform utility modules that still reference Linaria-specific metadata.

## Checklist

- [x] Search for direct transform-core references to Linaria-shaped metadata such as `__wyw_meta.extends`.
- [x] Remove selector-only className and CSS artifact special cases from core.
- [x] Ensure core handles generic static value kinds first and uses legacy metadata only as an adapter fallback.
- [x] Add or update tests that fail if core directly hardcodes Linaria metadata again.
- [x] Run focused tests.
- [x] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.
- 2026-05-08 16:15 EEST: Started after Linaria processor static contract landed in separate worktree commit `951ad37c`.
- 2026-05-08 16:25 EEST: Added `utils/processorStaticSemantics.ts` as the shared contract/legacy adapter. Same-file processor static collection now prefers `getStaticValue()` and only falls back to legacy `processor.value` parsing through that adapter.
- 2026-05-08 16:25 EEST: Added a contract-precedence transform test and expanded the boundary test so same-file collection no longer contains direct `__wyw_meta` parsing.
- 2026-05-08 16:25 EEST: Verification passed: `bun run --filter @wyw-in-js/transform build:types`, `bun run --filter @wyw-in-js/transform lint`, `bun run check:ts-size`, and `bun test src/__tests__/resolveStaticOxcValues.boundary.test.ts src/__tests__/transform.static-import-values.test.ts`.

## Context Recovery Notes

This cleanup should happen after Linaria processors implement the contract; otherwise dynamic/static behavior may regress.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/transform.static-import-values.test.ts src/__tests__/oxc-preeval-stage.test.ts`

## Done Criteria

- Transform core has no direct Linaria-specific static semantics.
- Tests cover adapter ownership.
