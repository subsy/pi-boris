---
name: boris-workflow
description: Use Boris Tane's research -> plan -> annotate -> implement workflow in pi. Use when the user wants a written research document, a reviewed plan document, annotation loops, and no code until the plan is approved.
---

# Boris Workflow

Use this workflow when the user wants the exact "read deeply, write a plan, annotate the plan, then implement" process.

## Rules

- Never implement non-trivial work before the user has reviewed and approved the plan document.
- Keep everything grounded in the actual codebase.
- Use persistent markdown artifacts, not chat-only summaries.
- Keep each work item in its own feature-specific folder under `docs/`.
- Stay in one long session unless the user explicitly asks to split or restart.
- During implementation, keep progress in the plan document via checkbox task lists.

## Preferred pi commands

If the package is installed, prefer these commands:

1. `/boris-start <task>`
2. `/boris-research [scope]`
3. `/boris-plan [goal]`
4. `/boris-review-loop [extra guidance]`
5. `/boris-open-plan`
6. `/boris-todos`
7. `/boris-implement`
8. `/boris-status`

`/boris-start` also supports category overrides:

- `--feature`
- `--bug`
- `--refactor`
- `--migration`
- `--spike`

## Docs structure

The extension keeps each work item in a dedicated folder like:

- `docs/features/<date>-<slug>/`
- `docs/bugs/<date>-<slug>/`
- `docs/refactors/<date>-<slug>/`
- `docs/migrations/<date>-<slug>/`
- `docs/spikes/<date>-<slug>/`

Each folder contains:

- `research.md`
- `plan.md`

## Phase mapping

### 1. Research

Kick off deep codebase study and write findings to the work item's `research.md`.

### 2. Planning

Use `research.md` plus fresh source reads to produce `plan.md`.
The extension can auto-open the current `plan.md` in the external editor.

### 3. Annotation loop

After the user edits `plan.md`, run another `/boris-review-loop` cycle.
Repeat until the user explicitly approves the plan.

### 4. Todo breakdown

Before implementation, make sure `plan.md` has a detailed checkbox task list.
Implementation should not start until this exists.

### 5. Implementation

Only after approval, execute the plan and mark tasks complete in `plan.md`.
Use red/green TDD whenever a test harness exists: write or update the test first, run it and observe the failure, then implement the minimum code and rerun until it passes.

## If commands are unavailable

Fall back to the prompt templates:

- `/boris-research-prompt`
- `/boris-plan-prompt`
- `/boris-annotate-prompt`
- `/boris-todos-prompt`
- `/boris-implement-prompt`
