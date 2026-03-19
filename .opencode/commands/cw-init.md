---
description: Initialize docs/prompt.md and docs/tasks.md for a chief-wiggum loop
---
Create the files needed to run a chief-wiggum development loop based on the user's prompt.

**User's prompt:** `$ARGUMENTS`

Follow these steps:

1. **Understand the codebase.** Explore the repo to understand the tech stack, project structure, patterns, and conventions. Be thorough — the quality of the tasks depends on this.

2. **Create `docs/prompt.md`** with this structure:
   ```markdown
   # Feature Name

   Brief description of what to build.

   ## Context
   - Relevant background (tech stack, key patterns, constraints)
   - Location in the codebase where work happens

   ## Acceptance Criteria
   - [ ] Criterion 1
   - [ ] Criterion 2
   ```
   Keep it concise — the tasks file handles the detailed breakdown.

3. **Create `docs/tasks.md`** using the format from `docs/task-format.md`. Key rules:
   - Group tasks under milestone headings: `## M1: Name`
   - Each task: `- [ ] m1-01: Task title`
   - Add `depends:` and `verify:` metadata where useful (indented 2 spaces)
   - Tasks should be atomic — one clear action each
   - Order milestones from foundational to final (setup → core → integration → polish)
   - IDs use the pattern `m{milestone}-{number}` (e.g., `m1-01`, `m2-03`)

4. **Report what was created** and suggest running `/cw-loop` to start.
