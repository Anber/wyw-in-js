# TASK-01: Planning Scaffold and Branch Setup

Status: done

## Goal

Create `anber/static-eval-architecture` from `anber/pr-312-static-imports-max`, add the plan/task scaffold, and establish the recovery workflow for the rest of the refactor.

## Files

- `PLAN.md`
- `PLAN.tasks/TASK-01-planning-scaffold.md`
- `PLAN.tasks/TASK-02-characterization-tests.md`
- `PLAN.tasks/TASK-03-shared-oxc-utils.md`
- `PLAN.tasks/TASK-04-split-template-dependencies.md`
- `PLAN.tasks/TASK-05-split-apply-processors.md`
- `PLAN.tasks/TASK-06-processor-static-contract.md`
- `PLAN.tasks/TASK-07-split-static-resolver.md`
- `PLAN.tasks/TASK-08-preeval-runtime-pipeline.md`
- `PLAN.tasks/TASK-09-linaria-contract.md`
- `PLAN.tasks/TASK-10-remove-core-heuristics.md`
- `PLAN.tasks/TASK-11-changeset.md`
- `PLAN.tasks/TASK-12-verification-perf-cleanup.md`

## Checklist

- [x] Confirm starting branch is `anber/pr-312-static-imports-max`.
- [x] Create branch `anber/static-eval-architecture`.
- [x] Add `PLAN.md`.
- [x] Add task files under `PLAN.tasks/`.
- [x] Set next active task to `TASK-02-characterization-tests.md`.

## Progress Log

- 2026-05-08 14:36 EEST: Confirmed clean `wyw-in-js` worktree on `anber/pr-312-static-imports-max` at `58c8143f9a9f1cf8d9fd55e3875d0af960efc841`.
- 2026-05-08 14:36 EEST: Created branch `anber/static-eval-architecture`.
- 2026-05-08 14:36 EEST: Added plan/task scaffold and marked `TASK-02` as the next active task.

## Context Recovery Notes

Read `PLAN.md`, verify branch with `git status --short --branch`, and continue from `TASK-02-characterization-tests.md`.

## Test Commands

- `git status --short --branch`
- `ls PLAN.tasks`

## Done Criteria

- Branch exists and is checked out.
- Plan scaffold is tracked in `wyw-in-js`.
- `PLAN.md` points to the next task.
