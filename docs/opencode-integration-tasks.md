# Chief-Wiggum OpenCode Integration Tasks

## Milestone 1: CLI Cleanup and JSON Output

Prepare the CLI for programmatic use by adding JSON output and removing the old run mode.

- [x] `m1-01` Add `--json` flag to FLAG_DEFS in parseArgs (~line 230)
  - completed: 2026-01-26T00:00:00.000Z
- [x] `m1-02` Add `--json` output mode to `cmdStatus` - output `{active, state, history, context}` as JSON when flag present
  - completed: 2026-01-26T00:00:00.000Z
- [x] `m1-03` Add `--json` output mode to `cmdTasks` - output `{total, complete, inProgress, todo, tasks}` as JSON
  - completed: 2026-01-26T00:00:00.000Z
- [x] `m1-04` Add `--json` output mode to `cmdContext` - output `{context}` or `{success, action}` as JSON
  - completed: 2026-01-26T00:00:00.000Z
- [x] `m1-05` Add `stop` to COMMANDS array
  - completed: 2026-01-26T00:00:00.000Z
- [x] `m1-06` Implement `cmdStop` function - sets `state.active = false`, outputs JSON result
  - completed: 2026-01-26T00:00:00.000Z
- [x] `m1-07` Update `main()` to handle `stop` command
  - completed: 2026-01-26T00:00:00.000Z
- [x] `m1-08` Update help text to document `stop` command and `--json` flag
  - completed: 2026-01-26T00:00:00.000Z
- [x] `m1-09` Remove `cmdRun` function and all agent-spawning logic (AGENTS config, streamProcessOutput, etc.)
  - completed: 2026-01-26T00:00:00.000Z
- [x] `m1-10` Remove unused imports and types after cmdRun removal
  - completed: 2026-01-26T00:00:00.000Z
- [x] `m1-11` Run `bun test` and fix any failures
  - completed: 2026-01-26T00:00:00.000Z
- [x] `m1-12` Run `npx biome check --write` to fix formatting
  - completed: 2026-01-26T16:37:00.000Z

## Milestone 2: WebSocket Server Foundation

Create the `serve` command with basic HTTP endpoints.

- [x] `m2-01` Add `serve` to COMMANDS array
  - started: 2026-01-26T17:00:00.000Z
  - completed: 2026-01-26T16:50:00.000Z
- [x] `m2-02` Add `--port` flag to FLAG_DEFS (default 3456)
  - started: 2026-01-26T17:00:00.000Z
  - completed: 2026-01-26T16:50:00.000Z
- [x] `m2-03` Create `cmdServe` function skeleton that starts Bun.serve()
  - started: 2026-01-26T17:00:00.000Z
  - completed: 2026-01-26T16:50:00.000Z
- [x] `m2-04` Implement GET `/status` endpoint - returns current state as JSON
  - started: 2026-01-26T17:00:00.000Z
  - completed: 2026-01-26T16:50:00.000Z
- [x] `m2-05` Implement GET `/history` endpoint - returns iteration history as JSON
  - started: 2026-01-26T17:00:00.000Z
  - completed: 2026-01-26T16:50:00.000Z
- [x] `m2-06` Implement GET `/tasks` endpoint - returns task summary and list as JSON
  - started: 2026-01-26T17:00:00.000Z
  - completed: 2026-01-26T16:50:00.000Z
- [x] `m2-07` Implement POST `/context` endpoint - adds context, returns success
  - started: 2026-01-26T17:00:00.000Z
  - completed: 2026-01-26T16:50:00.000Z
- [x] `m2-08` Implement POST `/stop` endpoint - signals stop, returns success
  - started: 2026-01-26T17:00:00.000Z
  - completed: 2026-01-26T16:50:00.000Z
- [x] `m2-09` Add proper CORS headers for local development
  - started: 2026-01-26T17:00:00.000Z
  - completed: 2026-01-26T16:50:00.000Z
- [x] `m2-10` Add request logging (method, path, status)
  - started: 2026-01-26T17:00:00.000Z
  - completed: 2026-01-26T16:50:00.000Z
- [x] `m2-11` Update help text to document `serve` command
  - started: 2026-01-26T17:00:00.000Z
  - completed: 2026-01-26T16:50:00.000Z
- [x] `m2-12` Test all HTTP endpoints with curl commands
  - started: 2026-01-26T16:50:00.000Z
  - completed: 2026-01-26T16:50:00.000Z
- [x] `m2-13` Run `bun test` and `npx biome check --write`
  - started: 2026-01-26T16:50:00.000Z
  - completed: 2026-01-26T16:50:00.000Z

## Milestone 3: Loop State Management Endpoints

Add endpoints for the subagent to manage loop lifecycle.

- [ ] `m3-01` Implement POST `/start` endpoint - initializes loop state, parses tasks, builds prompt, returns `{loopId, prompt, task?}`
- [ ] `m3-02` Implement POST `/iteration/complete` endpoint - records iteration result, returns `{next: "continue"|"complete"|"stop", task?, prompt?}`
- [ ] `m3-03` Implement GET `/next-task` endpoint - returns next task or completion signal
- [ ] `m3-04` Implement POST `/task/mark` endpoint - marks task status (in-progress, complete)
- [ ] `m3-05` Implement GET `/context` endpoint - returns pending context and clears it
- [ ] `m3-06` Extract prompt-building logic from old cmdRun into reusable `buildIterationPrompt()` function
- [ ] `m3-07` Generate unique loopId for each loop (use timestamp + random)
- [ ] `m3-08` Track iteration count in state, increment on each `/iteration/complete`
- [ ] `m3-09` Test full loop lifecycle via curl: start → complete → next → complete → ... → done
- [ ] `m3-10` Run `bun test` and `npx biome check --write`

## Milestone 4: WebSocket Event Streaming

Add WebSocket support for real-time event streaming.

- [ ] `m4-01` Add WebSocket upgrade handling in Bun.serve()
- [ ] `m4-02` Create `WebSocketManager` class to track connected clients
- [ ] `m4-03` Implement `/events` WebSocket endpoint
- [ ] `m4-04` Define event types: loop.started, iteration.started, iteration.completed, task.updated, context.received, loop.completed, loop.stopped, error
- [ ] `m4-05` Broadcast `loop.started` event when POST `/start` is called
- [ ] `m4-06` Broadcast `iteration.completed` event when POST `/iteration/complete` is called
- [ ] `m4-07` Broadcast `task.updated` event when POST `/task/mark` is called
- [ ] `m4-08` Broadcast `context.received` event when POST `/context` is called
- [ ] `m4-09` Broadcast `loop.completed` or `loop.stopped` events appropriately
- [ ] `m4-10` Handle WebSocket client disconnect gracefully
- [ ] `m4-11` Test WebSocket with wscat or similar tool
- [ ] `m4-12` Run `bun test` and `npx biome check --write`

## Milestone 5: OpenCode Plugin

Create the OpenCode plugin with custom tools.

- [ ] `m5-01` Create `.opencode/plugins/` directory
- [ ] `m5-02` Create `.opencode/plugins/chief-wiggum.ts` with imports
- [ ] `m5-03` Implement `status` tool - GET /status, return JSON
- [ ] `m5-04` Implement `start_loop` tool - POST /start with args (promptFile, prompt, tasksFile, milestone), return prompt
- [ ] `m5-05` Implement `complete_iteration` tool - POST /iteration/complete with args (filesModified, errors, notes)
- [ ] `m5-06` Implement `next_task` tool - GET /next-task, return task or completion
- [ ] `m5-07` Implement `get_context` tool - GET /context, return any pending context
- [ ] `m5-08` Implement `mark_task` tool - POST /task/mark with args (taskId, status)
- [ ] `m5-09` Implement `stop` tool - POST /stop
- [ ] `m5-10` Add error handling for connection failures (server not running)
- [ ] `m5-11` Add configurable server URL (default http://localhost:3456)
- [ ] `m5-12` Test each tool manually in OpenCode
- [ ] `m5-13` Run `npx biome check --write .opencode/`

## Milestone 6: OpenCode Subagent

Create the chief-wiggum subagent definition.

- [ ] `m6-01` Create `.opencode/agents/` directory
- [ ] `m6-02` Create `.opencode/agents/chief-wiggum.md` with frontmatter (description, mode: subagent, tools)
- [ ] `m6-03` Write subagent system prompt explaining its role as loop orchestrator
- [ ] `m6-04` Document the loop pattern: start_loop → work → complete_iteration → next_task → repeat
- [ ] `m6-05` Add instructions for checking/using injected context
- [ ] `m6-06` Add instructions for error handling and recovery
- [ ] `m6-07` Configure tool permissions: chief-wiggum_* allowed, read/write/edit/bash/glob/grep allowed
- [ ] `m6-08` Test subagent can be invoked with @chief-wiggum
- [ ] `m6-09` Test subagent can complete a simple single-task loop
- [ ] `m6-10` Test subagent can complete a multi-task loop with tasks file

## Milestone 7: End-to-End Testing and Polish

Verify everything works together and clean up.

- [ ] `m7-01` Create test prompt file `docs/test-prompt.md` for E2E testing
- [ ] `m7-02` Create test tasks file `docs/test-tasks.md` for E2E testing
- [ ] `m7-03` E2E test: Start server, invoke subagent, verify loop completes
- [ ] `m7-04` E2E test: Connect WebSocket client, verify events stream during loop
- [ ] `m7-05` E2E test: Inject context mid-loop, verify subagent receives it
- [ ] `m7-06` E2E test: Stop loop mid-execution, verify graceful shutdown
- [ ] `m7-07` Add server health check endpoint GET `/health`
- [ ] `m7-08` Add graceful server shutdown on SIGINT/SIGTERM
- [ ] `m7-09` Update README.md with new architecture and usage
- [ ] `m7-10` Remove any dead code or unused functions
- [ ] `m7-11` Final `bun test` and `npx biome check --write`
- [ ] `m7-12` Manual smoke test of complete workflow
