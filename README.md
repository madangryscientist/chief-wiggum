# Chief Wiggum

**A state management server for iterative AI development loops.**

> **Warning**: This is a personal project with no support. Breaking changes can happen at any time.

## What is this?

Chief Wiggum manages state, tasks, and history for AI development loops. Instead of spawning AI processes directly, it provides an HTTP/WebSocket API that AI agents (like OpenCode) can use as a subagent to orchestrate iterative work.

Based on the [Ralph Wiggum technique](https://ghuntley.com/ralph/) by Geoffrey Huntley.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        OpenCode                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              @chief-wiggum subagent                  │    │
│  │  - Calls chief-wiggum tools                         │    │
│  │  - Executes work (read, write, edit, bash, etc)     │    │
│  │  - Reports results back                             │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP/WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   chief-wiggum serve                         │
│  - Tracks loop state and iteration count                    │
│  - Manages structured tasks and milestones                  │
│  - Stores iteration history                                 │
│  - Handles context injection                                │
│  - Broadcasts events via WebSocket                          │
└─────────────────────────────────────────────────────────────┘
```

## Installation

### Prerequisites

- [Bun](https://bun.sh) - JavaScript runtime
- [OpenCode](https://opencode.ai) - AI agent with plugin support

### Setup

```bash
# Clone the repo
git clone https://github.com/madangryscientist/chief-wiggum
cd chief-wiggum

# Install dependencies
bun install

# Install OpenCode plugin dependencies
cd .opencode && bun install && cd ..

# Add an alias (optional)
echo 'alias chief-wiggum="bun ~/dev/chief-wiggum/chief-wiggum.ts"' >> ~/.zshrc
```

## Quick Start

### 1. Start the server

```bash
chief-wiggum serve --port 3456 --tasks-file docs/tasks.md
```

### 2. Use the @chief-wiggum subagent in OpenCode

```
@chief-wiggum Start a loop with prompt: "Implement the authentication module"
```

The subagent will:
1. Call `chief-wiggum_start_loop` to initialize
2. Execute the work using OpenCode's tools
3. Call `chief-wiggum_complete_iteration` with results
4. Continue until all tasks are done

### 3. Inject context mid-loop (from another terminal)

```bash
curl -X POST http://localhost:3456/context \
  -H "Content-Type: application/json" \
  -d '{"text": "Focus on error handling first"}'
```

## Commands

### `serve` - Start the HTTP/WebSocket server

```bash
chief-wiggum serve [options]

Options:
  -p, --port <port>       Port to listen on (default: 3456)
  -w, --workspace <dir>   Working directory
  -t, --tasks-file <path> Structured tasks file
```

### `status` - Show current state

```bash
chief-wiggum status [-w <dir>] [--json]
```

### `tasks` - List tasks

```bash
chief-wiggum tasks [-t <file>] [--json]
```

### `context` - Add or clear context

```bash
chief-wiggum context "your hint here"
chief-wiggum context --clear
```

### `stop` - Stop the active loop

```bash
chief-wiggum stop [-w <dir>]
```

## HTTP API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (status, version, uptime) |
| GET | `/status` | Current loop state |
| GET | `/history` | Iteration history |
| GET | `/tasks` | Task list and summary |
| GET | `/next-task` | Get next available task |
| GET | `/context` | Get and clear pending context |
| POST | `/start` | Start a new loop |
| POST | `/iteration/complete` | Record iteration result |
| POST | `/task/mark` | Mark task status |
| POST | `/context` | Add context |
| POST | `/stop` | Stop active loop |
| WS | `/events` | Real-time event stream |

### Example: Start a loop

```bash
curl -X POST http://localhost:3456/start \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Create the user authentication module",
    "tasksFile": "docs/tasks.md",
    "milestone": "M1"
  }'
```

### Example: Complete an iteration

```bash
curl -X POST http://localhost:3456/iteration/complete \
  -H "Content-Type: application/json" \
  -d '{
    "filesModified": ["src/auth.ts", "src/auth.test.ts"],
    "errors": [],
    "completionDetected": true
  }'
```

## OpenCode Plugin

The plugin provides 7 tools for the subagent:

| Tool | Description |
|------|-------------|
| `chief-wiggum_status` | Get current loop state |
| `chief-wiggum_start_loop` | Initialize a new loop |
| `chief-wiggum_complete_iteration` | Record iteration results |
| `chief-wiggum_next_task` | Get next available task |
| `chief-wiggum_get_context` | Check for injected context |
| `chief-wiggum_mark_task` | Update task status |
| `chief-wiggum_stop` | Stop the loop |

Configure the server URL via environment variable:
```bash
export CHIEF_WIGGUM_SERVER_URL=http://localhost:3456
```

## Structured Tasks Format

```markdown
# Project Tasks

## M1: Setup

- [x] `m1-001` Create project structure
  - verify: `ls -la src/`
  - completed: 2026-01-24T10:05:00Z

- [ ] `m1-002` Initialize npm
  - depends: m1-001
  - verify: `cat package.json`

## M2: Implementation

- [ ] `m2-001` Add authentication
  - depends: m1-002
```

## WebSocket Events

Connect to `ws://localhost:3456/events` to receive:

- `loop.started` - Loop initialized
- `iteration.started` - New iteration began
- `iteration.completed` - Iteration finished
- `task.updated` - Task status changed
- `context.received` - Context was injected
- `loop.completed` - All tasks done
- `loop.stopped` - Loop was stopped

## State Files

Stored in `.ralph/`:
- `ralph-loop.state.json` - Active loop state
- `ralph-history.json` - Iteration history
- `ralph-context.md` - Pending context
- `suggested-tasks.md` - Agent-suggested tasks

## License

MIT

## Credits

- Original Ralph Wiggum technique: [ghuntley.com/ralph](https://ghuntley.com/ralph/)
- Original implementation: [Th0rgal/ralph-wiggum](https://github.com/Th0rgal/ralph-wiggum)
