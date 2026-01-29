---
description: Show loop status and task progress
---
Read the following files and present a concise status summary:

**1. Loop state** — read `.ralph/ralph-loop.state.json`:
- `active` (boolean), `iteration`, `maxIterations`, `startedAt`, `model`, `agent`
- `structuredTasksFile` — path to the tasks file
- `milestoneFilter` — current milestone filter if any
- Show elapsed time since `startedAt`

**2. Iteration history** — read `.ralph/ralph-history.json`:
- Show total iterations completed, total time, and last 3 iterations with duration and status (completed/errors/ok)

**3. Task progress** — read the tasks file at the path from `structuredTasksFile` in the state (or `docs/tasks.md` if state not found):
- Tasks are markdown checkboxes: `- [ ]` (todo), `- [x]` (complete), `- [/]` (in-progress), `- [!]` (failed)
- Each has an ID in bold like `**T01**` and belongs to a milestone heading like `## M1: Name`
- Show counts: complete/total, in-progress, pending, failed
- List any in-progress or failed tasks by ID and title

If any file doesn't exist, skip that section and note it's unavailable.
