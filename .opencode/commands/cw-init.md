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

3. **Create `docs/tasks.md`** using the format below. Key rules:
   - Group tasks under milestone headings: `## M1: Name`
   - Each task: `- [ ] m1-01: Task title`
   - Add `depends:` and `verify:` metadata where useful (indented 2 spaces)
   - Tasks should be atomic — one clear action each
   - Order milestones from foundational to final (setup → core → integration → polish)
   - IDs use the pattern `m{milestone}-{number}` (e.g., `m1-01`, `m2-03`)

4. **Create `docs/task-format.md`** — a format reference so AI agents know how to add or modify tasks later. Write the following content exactly:

   ```markdown
   # Chief-Wiggum Task Format

   Quick reference for AI agents generating task files.

   ## File Locations

   | File | Default Path | Purpose |
   |------|--------------|---------|
   | Tasks file | `docs/tasks.md` | Structured task list with milestones |
   | Prompt file | `docs/prompt.md` | Overall goal/context for the loop |

   These are auto-detected. Just run `chief-wiggum run` if both files exist.

   Override with: `chief-wiggum run -f path/to/prompt.md -t path/to/tasks.md`

   ## Prompt File

   The prompt file contains the high-level goal and context. It's injected as "Your Main Goal" in each iteration.

   ```markdown
   # Feature Name

   Implement [feature description].

   ## Context
   - Relevant background info
   - Tech stack details
   - Constraints or requirements

   ## Acceptance Criteria
   - [ ] Criterion 1
   - [ ] Criterion 2
   ```

   Keep it concise - the tasks file handles the detailed breakdown.

   ## Task Line Format

   ```
   - [ ] task-id: Task title
   ```

   - **Status markers**: `[ ]` todo, `[/]` in-progress, `[x]` complete, `[!]` failed
   - **ID pattern**: `[a-zA-Z0-9_-]+` (e.g., `m1-01`, `setup-db`)
   - **Colon required** between ID and title

   ## File Structure

   ```markdown
   # Project Title

   ## M1: Milestone Name

   - [ ] m1-01: First task
     - depends: other-task-id
     - verify: `command to verify`

   ## M2: Next Milestone

   - [ ] m2-01: Task in milestone 2
     - depends: m1-01
   ```

   ## Metadata Fields

   Indented 2 spaces under task line:

   | Field | Purpose | Example |
   |-------|---------|---------|
   | `depends:` | Tasks that must complete first | `depends: m1-01, m1-02` |
   | `verify:` | Command to verify completion | `verify: \`bun test\`` |
   | `started:` | ISO timestamp (auto-added) | - |
   | `completed:` | ISO timestamp (auto-added) | - |

   ## Complete Example

   ```markdown
   # Authentication Feature

   ## M1: Setup

   - [x] m1-01: Create auth directory structure
     - verify: `ls src/auth/`
     - completed: 2026-01-27T10:00:00Z

   - [ ] m1-02: Add auth types
     - depends: m1-01
     - verify: `bun tsc --noEmit`

   ## M2: Core Implementation

   - [ ] m2-01: Implement login endpoint
     - depends: m1-02
     - verify: `bun test src/auth/login.test.ts`

   - [ ] m2-02: Implement logout endpoint
     - depends: m1-02

   - [ ] m2-03: Add session management
     - depends: m2-01, m2-02
   ```

   ## Common Mistakes

   | Wrong | Correct |
   |-------|---------|
   | `- [ ] Do the thing` | `- [ ] m1-01: Do the thing` |
   | `- [ ] m1 01: Task` | `- [ ] m1-01: Task` |
   | `- [ ] m1-01 Task` | `- [ ] m1-01: Task` |
   | `- depends: x` | `  - depends: x` |
   ```

5. **Report what was created** and suggest running `/cw-loop` to start.
