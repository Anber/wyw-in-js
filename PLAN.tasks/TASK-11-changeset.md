# TASK-11: Changeset

Status: done

## Goal

Add a public changeset for the v2 processor static contract.

## Files

- `.changeset/*.md`

## Checklist

- [x] Summarize the public processor static contract.
- [x] Avoid mentioning internal validation tooling.
- [x] Include only user-visible package changes.
- [x] Run changeset/package checks if available.
- [x] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.
- 2026-05-08 16:26 EEST: Added `.changeset/static-processor-contract.md` for the public processor static evaluation contract and transform support.
- 2026-05-08 16:26 EEST: Verification passed: `bun run --filter @wyw-in-js/processor-utils build:types` and `bun run --filter @wyw-in-js/transform build:types`.

## Context Recovery Notes

Keep public release text about API support and debug/behavioral compatibility only. Do not mention internal repo workflow details.

## Test Commands

- `cd wyw-in-js && bun run --filter @wyw-in-js/processor-utils build:types`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform build:types`

## Done Criteria

- Changeset exists and matches package changes.
