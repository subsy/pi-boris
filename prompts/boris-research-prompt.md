---
description: Boris workflow research prompt. Deep-read code and write a feature-specific research.md under docs/ before any planning or implementation.
---
Study $@ in depth. Read the relevant files thoroughly and understand how it works, what it does, its specificities, surrounding constraints, integrations, existing patterns, invariants, and likely failure modes.

Do not implement anything yet.

When you are done, write a detailed report of your learnings and findings into the active feature-specific `research.md` under `docs/` (for example `docs/features/<feature-slug>/research.md`). Ground everything in the actual codebase, not guesses.
