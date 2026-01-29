---
description: List all tasks with their status
---
Read `.ralph/ralph-loop.state.json` to get the `structuredTasksFile` path (fall back to `docs/tasks.md` if state not found), then read that tasks file.

The tasks file is markdown with:
- Milestone headings: `## M1: Name`
- Task checkboxes: `- [ ]` (todo), `- [x]` (complete), `- [/]` (in-progress), `- [!]` (failed)
- Each task has a bold ID like `**T01**` followed by the title
- Failed tasks may have a reason after `[reason: ...]`

Present:
1. Summary line: `X/Y complete, Z in-progress, W pending, V failed`
2. List every task with its status icon, ID, title, and milestone
   - Use `[x]` `[/]` `[ ]` `[!]` as status icons

If the file doesn't exist, say "No tasks file found."
