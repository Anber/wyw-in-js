# TASK-03: Shared Oxc Utility Extraction

Status: pending

## Goal

Extract shared Oxc helpers for parsing, visiting, replacements, and source locations so the large modules can be split without duplicating low-level AST code.

## Files

- `packages/transform/src/utils/oxc/*`
- `packages/transform/src/utils/applyOxcProcessors.ts`
- `packages/transform/src/utils/collectOxcTemplateDependencies.ts`
- `packages/transform/src/transform/generators/resolveStaticOxcValues.ts`

## Checklist

- [ ] Inventory duplicated Oxc helpers in the large modules.
- [ ] Create small utility modules with narrow exports.
- [ ] Move parsing/source-location helpers first.
- [ ] Move visitor/replacement helpers second.
- [ ] Keep public exported APIs stable.
- [ ] Run focused tests.
- [ ] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.

## Context Recovery Notes

Do not change static evaluation semantics in this task. This is an extraction-only step to lower risk for later splits.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/applyOxcProcessors.test.ts src/__tests__/collectOxcTemplateDependencies.test.ts src/__tests__/transform.static-import-values.test.ts`

## Done Criteria

- Shared Oxc utilities exist and are used by at least the modules touched in this task.
- Behavior stays covered by characterization tests.
