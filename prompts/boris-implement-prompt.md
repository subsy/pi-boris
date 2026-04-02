---
description: Boris workflow implementation prompt. Execute the active feature-specific plan.md under docs/ mechanically and mark tasks complete.
---
Implement the approved feature-specific `plan.md` under `docs/`.

When you finish a task or phase, mark its checkbox as completed in that `plan.md`.

Use red/green TDD whenever a test harness exists: write or update the test first, run it and observe it fail, then implement the minimal code, then rerun the test and watch it pass. Prefer the smallest targeted test command first, then broaden validation.

Do not stop until all in-scope tasks are complete. Do not add unnecessary comments or JSDoc. Do not use any or unknown types. Continuously run the project's typecheck or the closest equivalent validation command so you do not introduce new issues.

If the plan is ambiguous or conflicts with the codebase, stop and explain the exact issue instead of improvising.
