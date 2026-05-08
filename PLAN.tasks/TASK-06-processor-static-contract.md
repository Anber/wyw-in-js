# TASK-06: Processor Static Contract

Status: done

## Goal

Add the public optional static evaluation contract to `@wyw-in-js/processor-utils`.

## Files

- `packages/processor-utils/src/*`
- `packages/processor-utils/src/__tests__/*` if present, or new colocated tests.
- Type entrypoints and generated type exports.

## Checklist

- [x] Add `ProcessorStaticValue` union:
  - `serializable`
  - `class-name`
  - `selector-chain`
  - `runtime-callback`
  - `opaque-component`
  - `unresolved`
- [x] Add `ProcessorStaticContext` with read-only metadata, dependency tracking helpers, and debug reason helpers.
- [x] Add optional `BaseProcessor` methods:
  - `getStaticValue`
  - `resolveStaticInterpolation`
  - `resolveStaticTagTarget`
- [x] Preserve source and binary compatibility for processors that do not implement the contract.
- [x] Add type/export tests.
- [x] Run processor-utils tests and type build.
- [x] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.
- 2026-05-08 16:19 EEST: Started task after splitting `applyOxcProcessors`. Inspecting `processor-utils` exports and `BaseProcessor` shape before adding optional static methods.
- 2026-05-08 16:31 EEST: Added `static.ts` public type contract, exported it from `processor-utils`, and declared optional static methods on `BaseProcessor`.
- 2026-05-08 16:36 EEST: Added a static contract test. Verified processor-utils tests, type build, lint, and size guard.

## Context Recovery Notes

This contract is v2 public API. Avoid references to internal validation tooling in public text.

## Test Commands

- `cd wyw-in-js/packages/processor-utils && bun test src`
- `cd wyw-in-js && bun run --filter @wyw-in-js/processor-utils build:types`
- `cd wyw-in-js && bun run --filter @wyw-in-js/processor-utils lint`
- `cd wyw-in-js && bun run check:ts-size`

## Done Criteria

- Contract exports are public and optional.
- Existing processors compile without implementing the new methods.
