# Chief-Wiggum OpenCode Integration

## Goal

Transform chief-wiggum from a standalone CLI that spawns AI processes into a **state manager with WebSocket server** that integrates with OpenCode as a subagent.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenCode Primary Agent                    │
└─────────────────────────┬───────────────────────────────────┘
                          │ @chief-wiggum
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                 Chief-Wiggum Subagent                        │
│         (Orchestrates the loop using OpenCode natively)      │
│                                                              │
│  Has access to:                                              │
│  - chief-wiggum_* tools (state management)                  │
│  - OpenCode tools (read, write, edit, bash, glob, grep)     │
│                                                              │
│  Loop:                                                       │
│  1. chief-wiggum_start_loop → init state, get prompt/task   │
│  2. Do the work using OpenCode tools                        │
│  3. chief-wiggum_complete_iteration → record what happened  │
│  4. chief-wiggum_next_task → get next task or completion    │
│  5. Repeat until done                                        │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              Chief-Wiggum State Manager                      │
│                  (WebSocket Server)                          │
│                                                              │
│  `chief-wiggum serve --port 3456`                           │
│                                                              │
│  HTTP/WS Endpoints:                                          │
│  - GET  /status         → current state as JSON             │
│  - GET  /history        → iteration history                 │
│  - GET  /tasks          → task status                       │
│  - POST /context        → add context for next iteration    │
│  - POST /stop           → signal loop to stop               │
│  - WS   /events         → real-time event stream            │
│                                                              │
│  State stored in .ralph/ directory as before                │
└─────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

1. **No backwards compatibility** - Remove the old `chief-wiggum run` mode that spawns Claude/OpenCode. The new architecture has OpenCode running the loop natively.

2. **Bun.serve() for WebSocket** - Use Bun's native HTTP/WebSocket server, no external dependencies.

3. **chief-wiggum owns task parsing and prompt building** - The subagent receives ready-to-use prompts, doesn't need to understand task file format.

4. **State in .ralph/ directory** - Keep existing state location for familiarity.

## Files to Create/Modify

### Modify: `chief-wiggum.ts`

- Remove: `cmdRun`, agent spawning logic, process streaming
- Add: `cmdServe` - starts HTTP/WebSocket server
- Add: `--json` flag to `cmdStatus`, `cmdTasks`, `cmdContext`
- Add: `cmdStop` command
- Refactor: Extract state management, task parsing, prompt building into clean functions that can be called by server endpoints

### Create: `.opencode/plugins/chief-wiggum.ts`

Custom tools for the subagent:

| Tool | Description |
|------|-------------|
| `chief-wiggum_start_loop` | Initialize loop, return first prompt/task |
| `chief-wiggum_complete_iteration` | Record iteration result |
| `chief-wiggum_next_task` | Get next task or signal completion |
| `chief-wiggum_get_context` | Check for injected context |
| `chief-wiggum_mark_task` | Mark task status |
| `chief-wiggum_status` | Get current state |
| `chief-wiggum_stop` | Signal stop |

Tools communicate with the server via HTTP (not WebSocket) for simplicity.

### Create: `.opencode/agents/chief-wiggum.md`

Subagent definition that:
- Knows how to run ralph loops
- Has access to chief-wiggum_* tools + OpenCode tools
- Loops through tasks until completion
- Checks for context injection between iterations

## WebSocket Event Types

```typescript
type ServerEvent =
  | { type: "loop.started"; loopId: string; prompt: string; task?: StructuredTask }
  | { type: "iteration.started"; iteration: number }
  | { type: "iteration.completed"; iteration: number; result: IterationResult }
  | { type: "task.updated"; task: StructuredTask }
  | { type: "context.received"; text: string }
  | { type: "loop.completed"; history: RalphHistory }
  | { type: "loop.stopped"; reason: string }
  | { type: "error"; message: string }
```

## HTTP Endpoints

All endpoints accept/return JSON.

### GET /status
Returns current loop state, or null if no active loop.

### GET /history  
Returns iteration history for current or most recent loop.

### GET /tasks
Returns task summary and list.

### POST /start
Body: `{ promptFile?: string, prompt?: string, tasksFile?: string, milestone?: string }`
Initializes a new loop, returns the built prompt for first iteration.

### POST /iteration/complete
Body: `{ filesModified: string[], errors: string[], notes?: string }`
Records iteration completion, returns next action.

### POST /context
Body: `{ text: string }`
Adds context for next iteration.

### POST /stop
Signals loop should stop after current iteration.

## Testing

After each milestone, verify:
1. `bun test` passes
2. `chief-wiggum serve` starts without errors
3. HTTP endpoints return expected JSON
4. WebSocket events stream correctly

## Completion Criteria

The integration is complete when:
1. `chief-wiggum serve` runs a WebSocket server
2. OpenCode plugin provides all tools
3. OpenCode subagent can run a full ralph loop
4. External clients can watch progress via WebSocket
5. Context can be injected mid-loop via HTTP POST

## Reference

- Current chief-wiggum.ts implementation
- OpenCode plugin docs: https://opencode.ai/docs/plugins/
- OpenCode custom tools docs: https://opencode.ai/docs/custom-tools/
- OpenCode agents docs: https://opencode.ai/docs/agents/
- Bun HTTP/WebSocket: https://bun.sh/docs/api/http
