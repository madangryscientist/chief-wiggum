---
description: Review current branch changes against main
---
Use bash to run the following and then invoke @code-reviewer:

```bash
opencode run -m anthropic/claude-opus-4-5 "@code-reviewer"
```

If arguments are provided, they are ignored — the reviewer always diffs against main.
