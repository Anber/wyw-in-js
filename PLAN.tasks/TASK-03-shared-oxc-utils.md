# TASK-03: Shared Oxc Utility Extraction

Status: done

## Goal

Extract shared Oxc helpers for parsing, visiting, replacements, and source locations so the large modules can be split without duplicating low-level AST code.

## Files

- `packages/transform/src/utils/oxc/*`
- `packages/transform/src/utils/applyOxcProcessors.ts`
- `packages/transform/src/utils/collectOxcTemplateDependencies.ts`
- `packages/transform/src/transform/generators/resolveStaticOxcValues.ts`

## Checklist

- [x] Inventory duplicated Oxc helpers in the large modules.
- [x] Create small utility modules with narrow exports.
- [x] Move parsing/source-location helpers first.
- [x] Move visitor/replacement helpers second.
- [x] Keep public exported APIs stable.
- [x] Run focused tests.
- [x] Update `PLAN.md` status and progress log.

## Progress Log

- 2026-05-08 14:36 EEST: Task created by scaffold.
- 2026-05-08 14:52 EEST: Started task after committing `TASK-02`. Mapping existing Oxc helper responsibilities before extracting shared utilities.
- 2026-05-08 15:08 EEST: Added shared `utils/oxc` modules for AST child traversal/walk, cached parse facade, replacements, and source-location/code-frame helpers. Switched `applyOxcProcessors`, `collectOxcTemplateDependencies`, and `resolveStaticOxcValues` to consume them behind their existing APIs.
- 2026-05-08 15:13 EEST: Fixed the `ExpressionValue.buildCodeFrameError` property name after mechanical helper renaming; focused tests, type build, transform lint, and size guard passed.

## Context Recovery Notes

Do not change static evaluation semantics in this task. This is an extraction-only step to lower risk for later splits.

## Test Commands

- `cd wyw-in-js/packages/transform && bun test src/__tests__/applyOxcProcessors.test.ts src/__tests__/collectOxcTemplateDependencies.test.ts src/__tests__/transform.static-import-values.test.ts`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform build:types`
- `cd wyw-in-js && bun run --filter @wyw-in-js/transform lint`
- `cd wyw-in-js && bun run check:ts-size`

## Done Criteria

- Shared Oxc utilities exist and are used by at least the modules touched in this task.
- Behavior stays covered by characterization tests.
