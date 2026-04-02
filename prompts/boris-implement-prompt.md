---
description: Boris workflow implementation prompt. Execute the active feature-specific plan.md under docs/ mechanically and mark tasks complete.
---
Implement the approved feature-specific `plan.md` under `docs/`.

When you finish a task or phase, mark its checkbox as completed in that `plan.md`.

Do not stop until all in-scope tasks are complete. Do not add unnecessary comments or JSDoc. Do not use any or unknown types. Continuously run the project's typecheck or the closest equivalent validation command so you do not introduce new issues.

If the plan is ambiguous or conflicts with the codebase, stop and explain the exact issue instead of improvising.
