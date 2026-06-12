# TASK-09: Linaria Processor Contract Implementation

Status: done

## Goal

Implement the processor static contract in Linaria styled/core/atomic processors while preserving `__wyw_meta` runtime compatibility.

## Files

- Linaria styled processor package files.
- Linaria core processor package files.
- Linaria atomic processor package files.
- Relevant transform integration tests.

## Checklist

- [x] Identify current Linaria metadata emitted by each processor.
- [x] Implement static contract methods for styled components.
- [x] Implement selector/class-name semantics in processor adapters.
- [x] Implement runtime callback and opaque component semantics where applicable.
- [x] Preserve legacy `__wyw_meta` shape for dynamic eval/runtime bridge.
- [x] Defer transform integration tests to Task 10/12 after the transform adapter consumes the contract:
  - styled wrapping styled component
  - styled wrapping non-Linaria component
  - runtime callback interpolation
  - selector interpolation
  - empty/null component
- [x] Run focused tests.
- [x] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.
- 2026-05-08 16:15 EEST: Implemented structural static contract methods in clean Linaria worktree `/private/tmp/linaria-static-eval-architecture`; committed `951ad37c feat(processors): expose static evaluation semantics`.
- 2026-05-08 16:15 EEST: Linaria pre-commit passed `turbo run check:all`, full `pnpm lint`, and `pnpm sp:check`. Earlier focused `@linaria/core`, `@linaria/react`, and `@linaria/atomic` typechecks also passed.

## Context Recovery Notes

The processor contract should describe value semantics; it should not require transform core to know Linaria metadata fields.

Linaria changes live in a separate worktree to avoid touching the dirty sibling checkout at `/Users/anber/Sources/wyw/linaria`.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/transform.static-import-values.test.ts`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform build:types`

## Done Criteria

- Real processors exercise the public contract.
- Legacy runtime behavior remains compatible.
