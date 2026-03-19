# Chief Wiggum

A loop orchestrator for AI coding agents. It keeps an agent working on a task until the work is genuinely done.

> **Warning**: This is a personal project with no support. Breaking changes can happen at any time.

## The Problem

AI coding agents are great at starting work but bad at finishing it. They run one session, make some progress, then stop — leaving the work half-done. You re-run them, they re-explore the codebase, re-read the same files, and stall again. There's no forcing function that ensures the job actually gets completed.

## How It Works

Chief Wiggum adds a contract between you and the AI agent: **the agent must output `<promise>COMPLETE</promise>` to be allowed to stop.** Until it does, the loop keeps running.

Here's the cycle:

1. You provide a **prompt** (what to build) and a **task list** (the breakdown with dependencies and verification commands)
2. The agent works — reads files, writes code, runs tests
3. After each iteration, the agent must signal either `<promise>READY_FOR_NEXT_TASK</promise>` (finished one task, ready for the next) or `<promise>COMPLETE</promise>` (all tasks done)
4. Changes are auto-committed, a code review runs automatically, and any review findings are fed back as context for the next iteration
5. The loop repeats until `COMPLETE` — or a human stops it

This is based on the [Ralph Wiggum technique](https://ghuntley.com/ralph/) by Geoffrey Huntley.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) — JavaScript runtime
- [OpenCode](https://opencode.ai) — AI agent with plugin support

### Setup

```bash
git clone https://github.com/madangryscientist/chief-wiggum
cd chief-wiggum
bun install
cd .opencode && bun install && cd ..

# Add an alias (optional)
echo 'alias chief-wiggum="bun ~/dev/chief-wiggum/chief-wiggum.ts"' >> ~/.zshrc
```

### Start a loop

The fastest way to get started is from OpenCode's chat:

```
/cw-init Build a REST API for user authentication with JWT tokens
```

This generates `docs/prompt.md` (the goal) and `docs/tasks.md` (the task breakdown). Then start the loop:

```bash
chief-wiggum run
```

That's it. Chief Wiggum picks up both files automatically, spawns the agent, and starts iterating.

To create the files manually instead:

```bash
# docs/prompt.md — what you want to build
# docs/tasks.md  — the task breakdown (see Task Format below)
chief-wiggum run -f docs/prompt.md -t docs/tasks.md
```

### Watch and guide

While the loop runs, you can inject context at any time:

```bash
# From another terminal
chief-wiggum context "Focus on error handling, skip the tests for now"

# Or from OpenCode chat
/cw-inject Focus on error handling, skip the tests for now

# Or via HTTP
curl -X POST http://localhost:3456/context \
  -H "Content-Type: application/json" \
  -d '{"text": "Focus on error handling"}'
```

The agent receives your guidance at the start of its next iteration, then the context is cleared.

## Two Modes

### Direct mode (`run`)

Chief Wiggum spawns the AI agent process and manages the loop itself. Simplest way to use it.

```bash
chief-wiggum run [options]
```

- Spawns the agent (OpenCode, Claude Code, or Codex) as a subprocess
- Auto-commits changes after each iteration
- Runs a code review after each iteration
- Prevents macOS from sleeping during long loops
- Also starts an HTTP server for context injection and status checks

### Server mode (`serve`)

Chief Wiggum runs as an HTTP server only. The `@chief-wiggum` OpenCode subagent connects to it and orchestrates itself.

```bash
chief-wiggum serve [options]
```

Then in OpenCode chat:

```
@chief-wiggum Start a loop with tasksFile: "docs/tasks.md"
```

Best for: active observation, live guidance from a separate chat window, complex multi-agent setups. A human can watch the loop using the observer plugin tools while the subagent works.

| | Direct mode (`run`) | Server mode (`serve`) |
|---|---|---|
| How it works | Chief Wiggum spawns the agent | OpenCode subagent connects via HTTP |
| Agent support | OpenCode, Claude Code, Codex | OpenCode only |
| Best for | Fire-and-forget, CI, headless | Active observation, live guidance |
| Human control | CLI, HTTP | Slash commands, observer plugin, HTTP |

## Task Format

Tasks are defined in a markdown file (`docs/tasks.md` by default). Each task has an ID, a title, optional dependencies, and an optional verification command.

```markdown
# Authentication Feature

## M1: Setup

- [ ] m1-01: Create auth directory structure
  - verify: `ls src/auth/`

- [ ] m1-02: Add auth types and interfaces
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

**Status markers**: `[ ]` todo, `[/]` in-progress, `[x]` complete, `[!]` failed

**Dependency resolution**: A task only becomes available when all its dependencies are complete. If a dependency fails, all tasks that depend on it are automatically blocked.

**Milestones**: Use `## M1:`, `## M2:` etc. Run a single milestone with `-M M1`.

See [docs/task-format.md](docs/task-format.md) for the full format reference.

## Slash Commands

Available in OpenCode chat when the plugins are installed:

| Command | Description |
|---|---|
| `/cw-init` | Generate `docs/prompt.md` and `docs/tasks.md` from a description |
| `/cw-loop` | Start a loop in a new terminal split |
| `/cw-status` | Show loop status and task progress |
| `/cw-tasks` | List all tasks with their current status |
| `/cw-review` | Run a code review of the current branch against main |
| `/cw-inject` | Inject context into the running loop |
| `/cw-stop` | Stop the running loop |
| `/cw-summary` | Analyze logs for patterns and inefficiencies |
| `/cw-suggestions` | View tasks suggested by the agent during iterations |
| `/cw-archive` | Archive current logs to start fresh |
| `/cw-fail` | Fail a task, stop the loop, and restart |

## Key Behaviours

**Automatic code review** — After every iteration, the `code-reviewer` OpenCode agent (`anthropic/claude-opus-4-6`) reviews the branch diff against `main`. It checks for three things: unnecessary code bloat, low-value tests, and custom components that duplicate existing ones. If issues are found, the full review is injected as context for the next iteration so the agent can fix them.

**Context injection** — A human can send text to the loop at any time. It's included in the next iteration's prompt and then cleared. Use the CLI (`chief-wiggum context "..."`), a slash command (`/cw-inject`), or HTTP (`POST /context`).

**Auto-commit** — In direct mode, every iteration's file changes are committed automatically with a `"Ralph iteration N: work in progress"` message. Disable with `--no-commit`.

**Sleep prevention** — On macOS, `caffeinate -i` runs automatically to prevent the machine from sleeping during long loops.

**Task suggestions** — The agent can suggest new tasks during its work by including `<suggest-task>Description</suggest-task>` in its output. Suggestions are collected in `.ralph/suggested-tasks.md` for human review via `/cw-suggestions`.

**Struggle detection** — Chief Wiggum tracks signs that the agent is stuck: repeated errors (same error across multiple iterations), no-progress iterations (no files changed, no task completed), and short iterations (< 30 seconds, usually a crash). Visible in `/cw-summary` and `GET /history`.

---

# Reference

## Commands

### `run` — Start a loop in direct mode

```
chief-wiggum run [options] [prompt]
chief-wiggum run                        # Uses docs/prompt.md + docs/tasks.md
chief-wiggum run -f prompt.md -t tasks.md -M M1
```

| Flag | Description | Default |
|---|---|---|
| `-f, --prompt <file>` | Prompt file path | `docs/prompt.md` |
| `-t, --tasks-file <path>` | Structured tasks file | `docs/tasks.md` |
| `-M, --milestone <name>` | Filter by milestone | all |
| `-m, --model <name>` | Model for the agent | `anthropic/claude-opus-4-5` |
| `-a, --agent <type>` | Agent: `opencode`, `claude-code`, `codex` | `opencode` |
| `-n, --iterations <n>` | Max iterations (0 = unlimited) | `0` |
| `--timeout <mins>` | Inactivity timeout in minutes | `30` |
| `-p, --port <port>` | HTTP server port | `3456` |
| `-w, --workspace <dir>` | Working directory | current dir |
| `--repo <path>` | Git repo for worktree creation | — |
| `-b, --branch <name>` | Branch name for worktree | — |
| `--force` | Clear stale state and start fresh | — |
| `--no-commit` | Disable auto-commit | — |
| `-i, --interactive` | Require permission prompts | auto-approve |
| `--no-plugins` | Disable non-auth plugins (opencode) | — |
| `--no-log` | Disable logging | — |
| `-v, --verbose` | Verbose tool output | — |
| `-q, --quiet` | Buffer output (no streaming) | — |

### `serve` — Start the HTTP server only

```
chief-wiggum serve [options]
```

Starts the HTTP/WebSocket server and waits for connections. Does not spawn an agent — the `@chief-wiggum` OpenCode subagent connects to it.

| Flag | Description | Default |
|---|---|---|
| `-p, --port <port>` | Port to listen on | `3456` |
| `-w, --workspace <dir>` | Working directory | current dir |
| `-t, --tasks-file <path>` | Structured tasks file | `docs/tasks.md` |
| `-M, --milestone <name>` | Filter by milestone | all |
| `--force` | Kill existing process on port | — |

### `status` — Show loop status

```
chief-wiggum status [-w <dir>] [--json]
```

### `context` — Add or clear context

```
chief-wiggum context "your guidance here"
chief-wiggum context --clear
```

### `tasks` — List tasks

```
chief-wiggum tasks [-t <file>] [--json]
```

### `assist` — Open OpenCode with loop context

```
chief-wiggum assist
```

Opens OpenCode TUI pre-loaded with the current loop context (goal, task progress, history) for manual intervention.

## HTTP API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check — returns `{status, version, uptime}` |
| `GET` | `/status` | Current loop state, history, and pending context |
| `GET` | `/history` | Full iteration history with struggle indicators |
| `GET` | `/tasks` | Task list with status counts |
| `GET` | `/next-task` | Next available task (respects dependencies) |
| `GET` | `/context` | Get and clear pending context |
| `GET` | `/logs/raw` | Raw log content for analysis |
| `GET` | `/logs` | List or read archived log files |
| `GET` | `/suggested-tasks` | Agent-suggested tasks |
| `GET` | `/summary` | Analyzed log summary |
| `POST` | `/start` | Start a new loop |
| `POST` | `/iteration/complete` | Record iteration results, advance state |
| `POST` | `/task/mark` | Update task status (`todo`, `in-progress`, `complete`, `failed`) |
| `POST` | `/context` | Inject context for next iteration |
| `POST` | `/stop` | Stop the active loop |
| `POST` | `/logs/archive` | Move logs to archive |
| `WS` | `/events` | Real-time event stream |

### POST /start

```json
{
  "prompt": "Build the auth module",
  "tasksFile": "docs/tasks.md",
  "milestone": "M1"
}
```

Returns: `{success, loopId, prompt, task, iteration}`

### POST /iteration/complete

```json
{
  "filesModified": ["src/auth.ts", "src/auth.test.ts"],
  "errors": [],
  "notes": "Implemented login endpoint",
  "completionDetected": true
}
```

Returns: `{success, next: "continue"|"complete"|"stop", iteration, prompt, task}`

### POST /context

```json
{
  "text": "Focus on error handling first"
}
```

Returns: `{success, action: "added"}`

### GET /context

Returns: `{hasContext, context, clearedAt}` — context is deleted after retrieval.

## OpenCode Plugins

### Subagent Plugin (`chief-wiggum`)

Tools available to the `@chief-wiggum` subagent:

| Tool | Description |
|---|---|
| `chief-wiggum_start_loop` | Initialize a new loop |
| `chief-wiggum_complete_iteration` | Record iteration results, get next prompt |
| `chief-wiggum_next_task` | Get next available task |
| `chief-wiggum_get_context` | Check for injected context (clears after read) |
| `chief-wiggum_mark_task` | Update task status |
| `chief-wiggum_stop` | Stop the loop |
| `chief-wiggum_status` | Get current loop state |
| `chief-wiggum_summary` | Get raw logs for analysis |
| `chief-wiggum_logs` | List or read archived logs |
| `chief-wiggum_archive_logs` | Move logs to archive |
| `chief-wiggum_suggested_tasks` | Get agent-suggested tasks |

### Observer Plugin (`chief-wiggum-observer`)

Tools for the main OpenCode chat — lets a human watch and guide a running loop:

| Tool | Description |
|---|---|
| `chief-wiggum-observer_loop_status` | Check loop progress |
| `chief-wiggum-observer_inject_context` | Send guidance to the subagent |
| `chief-wiggum-observer_stop_loop` | Stop the loop |
| `chief-wiggum-observer_list_tasks` | Show all tasks with status |
| `chief-wiggum-observer_summarize_loop` | Get iteration summary and struggle indicators |
| `chief-wiggum-observer_health_check` | Check server health |

Configure the server URL:
```bash
export CHIEF_WIGGUM_SERVER_URL=http://localhost:3456
```

## WebSocket Events

Connect to `ws://localhost:3456/events` to receive real-time updates:

| Event | When | Payload |
|---|---|---|
| `loop.started` | Loop initialized | `{loopId, prompt, task?}` |
| `iteration.started` | Iteration began | `{iteration, loopId}` |
| `iteration.completed` | Iteration finished | `{iteration, result: {durationMs, filesModified, errors, completionDetected}}` |
| `task.updated` | Task status changed | `{taskId, status}` |
| `context.received` | Context injected | `{text}` |
| `loop.completed` | All tasks done | `{history, loopId}` |
| `loop.stopped` | Loop stopped | `{reason, loopId, iteration}` |

## State Files

All state is stored in `.ralph/` in the workspace root:

| File | Purpose |
|---|---|
| `ralph-loop.state.json` | Active loop state (iteration, model, agent, config) |
| `ralph-history.json` | Per-iteration history (tools used, files modified, errors, durations) |
| `ralph-context.md` | Pending context for next iteration |
| `suggested-tasks.md` | Tasks suggested by the agent via `<suggest-task>` tags |
| `logs/*.log` | Timestamped session logs |
| `logs/archive/*.log` | Archived logs from previous sessions |
| `ralph-opencode.config.json` | Generated OpenCode config (permissions, plugin filtering) |
| `assist-context.md` | Context file for `chief-wiggum assist` |

## Worktree Support

The `--repo` flag creates a git worktree for isolated feature development:

```bash
chief-wiggum run --repo /path/to/repo -f docs/prompt.md
```

The prompt file's heading is used to name the branch and worktree path. This lets you run multiple loops on different features simultaneously without branch conflicts.

## License

MIT

## Credits

- Original Ralph Wiggum technique: [ghuntley.com/ralph](https://ghuntley.com/ralph/)
- Original implementation: [Th0rgal/ralph-wiggum](https://github.com/Th0rgal/ralph-wiggum)
