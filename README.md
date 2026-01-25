# Chief Wiggum

**A personal fork of [Ralph Wiggum](https://github.com/Th0rgal/ralph-wiggum) optimized for my workflow.**

> **Warning**: This is a personal project with no support. Breaking changes can happen at any time. Feel free to use it as a base to fork from, but don't expect stability or backwards compatibility.

## What is this?

Chief Wiggum runs iterative AI development loops (called "Ralph loops") with enhanced features for managing complex, multi-milestone projects. It's built for my specific workflow needs.

Based on the [Ralph Wiggum technique](https://ghuntley.com/ralph/) by Geoffrey Huntley.

## Key Differences from Original Ralph Wiggum

| Feature | Original | Chief Wiggum |
|---------|----------|--------------|
| **CLI name** | `ralph` | `chief-wiggum` |
| **Subcommands** | Flags only (`--status`, `--add-context`) | Proper subcommands (`status`, `context`, `tasks`) |
| **Structured tasks** | Basic markdown tasks | Milestones, dependencies, verification commands |
| **Git worktrees** | Not supported | Auto-create worktrees with `--repo` |
| **Inactivity timeout** | None | Kill stalled processes after N minutes (default: 30) |
| **Task suggestions** | None | Agent can suggest tasks via `<suggest-task>` |
| **Milestone filtering** | None | Filter tasks by milestone with `-M` |
| **Milestone tagging** | None | Auto-tags git on milestone completion |

## Installation

### Prerequisites

- [Bun](https://bun.sh) - JavaScript runtime
- At least one AI agent CLI:
  - [OpenCode](https://opencode.ai) (default)
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
  - [Codex](https://github.com/openai/codex)

### Setup

```bash
# Clone the repo
git clone https://github.com/madangryscientist/chief-wiggum
cd chief-wiggum

# Install dependencies
bun install

# Option 1: Run directly with bun
bun chief-wiggum.ts [command] [options]

# Option 2: Add an alias to your shell config (~/.zshrc or ~/.bashrc)
echo 'alias chief-wiggum="bun ~/dev/chief-wiggum/chief-wiggum.ts"' >> ~/.zshrc
source ~/.zshrc

# Option 3: Create a symlink in your PATH
ln -s ~/dev/chief-wiggum/chief-wiggum.ts /usr/local/bin/chief-wiggum
```

### Verify installation

```bash
chief-wiggum --version
# chief-wiggum 2.0.0

chief-wiggum --help
```

## Quick Start

```bash
# Start a Ralph loop with structured tasks
chief-wiggum run -f prompt.md -t docs/tasks.md -M M2b -n 50

# Check status
chief-wiggum status

# Add context mid-loop (from another terminal)
chief-wiggum context "focus on the auth module"

# List tasks
chief-wiggum tasks -t docs/tasks.md
```

## Commands

### `run` - Start the Ralph loop

```bash
chief-wiggum run [options] [prompt]
chief-wiggum -f <file> [options]

Core:
  -f, --prompt <file>     Prompt file path
  -n, --iterations <n>    Max iterations (0=unlimited)
  -m, --model <name>      Model (default: anthropic/claude-sonnet-4-5)
  -a, --agent <type>      Agent: opencode, claude-code, codex

Tasks:
  -t, --tasks-file <path> Structured tasks file
  -M, --milestone <name>  Filter by milestone
  --done <phrase>         Completion promise (default: COMPLETE)
  --next <phrase>         Task promise (default: READY_FOR_NEXT_TASK)

Workspace:
  -w, --workspace <dir>   Working directory
  --repo <path>           Git repo for worktree creation
  -b, --branch <name>     Branch name for worktree

Behavior:
  --timeout <mins>        Inactivity timeout (default: 30, 0=disable)
  --force                 Clear stale state and start
  -v, --verbose           Verbose tool output
  -q, --quiet             Buffer output (no streaming)
  --no-commit             Disable auto-commit
  -i, --interactive       Require permission prompts
  --log                   Log to .ralph/logs/
```

### `status` - Show loop status

```bash
chief-wiggum status [-w <dir>]
```

### `context` - Add context for next iteration

```bash
chief-wiggum context "your hint here"
chief-wiggum context --clear
```

### `tasks` - Manage tasks

```bash
chief-wiggum tasks                    # List tasks
chief-wiggum tasks add "description"  # Add task
chief-wiggum tasks rm <index>         # Remove task
```

## Structured Tasks Format

```markdown
# Project Tasks

## M1: Setup

- [x] m1-001: Create project
  - verify: `ls -la project/`
  - started: 2026-01-24T10:00:00Z
  - completed: 2026-01-24T10:05:00Z

- [ ] m1-002: Initialize npm
  - depends: m1-001
  - verify: `cat package.json`

## M2: Implementation

- [ ] m2-001: Add feature
  - depends: m1-002
  - verify: `npm test`
```

## Git Worktree Support

Start work in an isolated worktree:

```bash
chief-wiggum run \
  -f ~/plans/migration.md \
  --repo ~/dev/my-project \
  -t docs/tasks.md \
  -M M1 \
  -n 50
```

This:
1. Creates `~/dev/my-project.worktrees/<branch-from-prompt-title>/`
2. Copies prompt to `.ralph/ralph-prompt.md`
3. Copies tasks file
4. Runs the loop in the worktree

## Inactivity Timeout

If the agent produces no output for 30 minutes (default), the process is killed and the iteration restarts. Configure with:

```bash
--timeout 15      # 15 minute timeout
--timeout 0       # Disable timeout
```

## Task Suggestions

The agent can suggest new tasks during execution:

```
<suggest-task>Add input validation to the form</suggest-task>
<suggest-task milestone="M2b">Fix the CSS layout issue</suggest-task>
```

Suggestions are saved to `.ralph/suggested-tasks.md` for review.

## State Files

Stored in `.ralph/`:
- `ralph-loop.state.json` - Active loop state
- `ralph-history.json` - Iteration history
- `ralph-context.md` - Pending context
- `suggested-tasks.md` - Agent-suggested tasks
- `logs/` - Session logs

## License

MIT

## Credits

- Original Ralph Wiggum technique: [ghuntley.com/ralph](https://ghuntley.com/ralph/)
- Original implementation: [Th0rgal/ralph-wiggum](https://github.com/Th0rgal/ralph-wiggum)
