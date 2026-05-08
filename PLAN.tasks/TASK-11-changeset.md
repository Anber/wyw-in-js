# TASK-11: Changeset

Status: pending

## Goal

Add a public changeset for the v2 processor static contract.

## Files

- `.changeset/*.md`

## Checklist

- [ ] Summarize the public processor static contract.
- [ ] Avoid mentioning internal validation tooling.
- [ ] Include only user-visible package changes.
- [ ] Run changeset/package checks if available.
- [ ] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.

## Context Recovery Notes

Keep public release text about API support and debug/behavioral compatibility only. Do not mention internal repo workflow details.

## Test Commands

- `cd wyw-in-js && bun run --filter @wyw-in-js/processor-utils build:types`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform build:types`

## Done Criteria

- Changeset exists and matches package changes.
