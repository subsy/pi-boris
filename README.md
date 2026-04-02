# pi-boris

An opinionated pi package that codifies Boris Tane's workflow:

1. deep research into the existing codebase
2. a written research document
3. a written implementation plan
4. one or more annotation loops on the plan
5. implementation only after the plan is approved
6. checkbox progress tracked in the plan document

## Docs layout

Every new feature/work item gets its own folder under `docs/`.

The extension infers a category from the task and creates folders like:

- `docs/features/2026-04-02-cursor-pagination/`
- `docs/bugs/2026-04-02-task-cancellation-regression/`
- `docs/refactors/2026-04-02-auth-cleanup/`
- `docs/migrations/2026-04-02-drizzle-upgrade/`
- `docs/spikes/2026-04-02-notification-system-investigation/`

You can override the inferred category on start:

- `/boris-start --feature ...`
- `/boris-start --bug ...`
- `/boris-start --refactor ...`
- `/boris-start --migration ...`
- `/boris-start --spike ...`

Inside each folder it maintains:

- `research.md`
- `plan.md`

## Commands

- `/boris-start <task>` — create a new feature-specific docs folder and immediately start the research phase
- `/boris-research [scope]` — run another deep research pass into that feature's `research.md`
- `/boris-plan [goal]` — generate that feature's concrete `plan.md`
- `/boris-annotate` — address inline notes in `plan.md` without implementing
- `/boris-review-loop [extra guidance]` — preferred repeated review/annotation loop command
- `/boris-open-plan` — open the current `plan.md` in your external editor
- `/boris-todos` — add a detailed checkbox task list to `plan.md`
- `/boris-implement` — execute `plan.md` and mark tasks complete
- `/boris-status` — show the current stage, docs folder, and progress
- `/boris-reset` — clear workflow state but keep the docs artifacts

## Behavior

- During research/planning/annotation, bash is limited to read-only commands.
- During research, only the feature's `research.md` can be edited.
- During planning/annotation, only the feature's `plan.md` can be edited.
- During planning/annotation/todo generation, the extension tries to auto-open the active `plan.md` in your external editor.
- During implementation, full code editing is allowed again.
- During implementation, the workflow now explicitly pushes red/green TDD when a test harness exists: write/update the test first, run it to see it fail, then implement, then rerun until it passes.
- A widget above the editor shows the current stage, docs folder, and implementation progress.
- Custom rendered stage banners show Boris workflow transitions in the chat.
- Tree checkpoints are labeled at each stage start and completion checkpoint.
- Implementation is blocked until `plan.md` contains a non-empty checkbox task list.

## Included prompt templates

- `/boris-research-prompt`
- `/boris-plan-prompt`
- `/boris-annotate-prompt`
- `/boris-todos-prompt`
- `/boris-implement-prompt`

## Typical flow

```text
/boris-start --feature add cursor pagination to the list endpoint
# review docs/features/.../research.md
/boris-plan support cursor-based pagination for the list endpoint
# edit docs/features/.../plan.md
/boris-review-loop
# repeat until the plan is approved
/boris-todos
/boris-implement
```
