# TASK-06: Processor Static Contract

Status: pending

## Goal

Add the public optional static evaluation contract to `@wyw-in-js/processor-utils`.

## Files

- `packages/processor-utils/src/*`
- `packages/processor-utils/src/__tests__/*` if present, or new colocated tests.
- Type entrypoints and generated type exports.

## Checklist

- [ ] Add `ProcessorStaticValue` union:
  - `serializable`
  - `class-name`
  - `selector-chain`
  - `runtime-callback`
  - `opaque-component`
  - `unresolved`
- [ ] Add `ProcessorStaticContext` with read-only metadata, dependency tracking helpers, and debug reason helpers.
- [ ] Add optional `BaseProcessor` methods:
  - `getStaticValue`
  - `resolveStaticInterpolation`
  - `resolveStaticTagTarget`
- [ ] Preserve source and binary compatibility for processors that do not implement the contract.
- [ ] Add type/export tests.
- [ ] Run processor-utils tests and type build.
- [ ] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.

## Context Recovery Notes

This contract is v2 public API. Avoid references to internal validation tooling in public text.

## Test Commands

- `cd wyw-in-js/packages/processor-utils && bun test src`
- `cd wyw-in-js && bun run --filter @wyw-in-js/processor-utils build:types`

## Done Criteria

- Contract exports are public and optional.
- Existing processors compile without implementing the new methods.
