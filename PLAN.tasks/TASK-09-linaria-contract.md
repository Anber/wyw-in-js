# TASK-09: Linaria Processor Contract Implementation

Status: pending

## Goal

Implement the processor static contract in Linaria styled/core/atomic processors while preserving `__wyw_meta` runtime compatibility.

## Files

- Linaria styled processor package files.
- Linaria core processor package files.
- Linaria atomic processor package files.
- Relevant transform integration tests.

## Checklist

- [ ] Identify current Linaria metadata emitted by each processor.
- [ ] Implement static contract methods for styled components.
- [ ] Implement selector/class-name semantics in processor adapters.
- [ ] Implement runtime callback and opaque component semantics where applicable.
- [ ] Preserve legacy `__wyw_meta` shape for dynamic eval/runtime bridge.
- [ ] Add integration tests:
  - styled wrapping styled component
  - styled wrapping non-Linaria component
  - runtime callback interpolation
  - selector interpolation
  - empty/null component
- [ ] Run focused tests.
- [ ] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.

## Context Recovery Notes

The processor contract should describe value semantics; it should not require transform core to know Linaria metadata fields.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/transform.static-import-values.test.ts`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform build:types`

## Done Criteria

- Real processors exercise the public contract.
- Legacy runtime behavior remains compatible.
