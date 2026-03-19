#!/usr/bin/env bun

/**
 * Chief Wiggum - Iterative AI development loop
 *
 * Fork of Ralph Wiggum with enhanced task management, worktree support,
 * and structured milestone tracking. Based on ghuntley.com/ralph/
 */

import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const VERSION = "2.0.0";

// ============================================================================
// Types
// ============================================================================

type AgentType = "opencode" | "claude-code" | "codex";

interface StructuredTask {
	id: string;
	title: string;
	milestone: string | null;
	status: "todo" | "in-progress" | "complete" | "failed";
	depends: string[];
	verify: string | null;
	started: string | null;
	completed: string | null;
	failedReason: string | null;
	originalLines: string[];
}

interface ParsedTasksFile {
	milestones: Map<string, StructuredTask[]>;
	allTasks: Map<string, StructuredTask>;
}

interface Task {
	text: string;
	status: "todo" | "in-progress" | "complete";
	subtasks: Task[];
	originalLine: string;
}

interface IterationHistory {
	iteration: number;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	toolsUsed: Record<string, number>;
	filesModified: string[];
	exitCode: number;
	completionDetected: boolean;
	errors: string[];
}

interface RalphHistory {
	iterations: IterationHistory[];
	totalDurationMs: number;
	struggleIndicators: {
		repeatedErrors: Record<string, number>;
		noProgressIterations: number;
		shortIterations: number;
	};
}

interface RalphState {
	active: boolean;
	iteration: number;
	maxIterations: number;
	completionPromise: string;
	tasksMode: boolean;
	taskPromise: string;
	prompt: string;
	promptFile?: string | null;
	startedAt: string;
	model: string;
	agent: AgentType;
	workspaceRoot?: string;
	structuredTasksFile?: string | null;
	milestoneFilter?: string | null;
	logFile?: string | null;
	loopId?: string | null;
}

interface AgentConfig {
	type: AgentType;
	command: string;
	buildArgs: (
		prompt: string,
		model: string,
		options?: { allowAllPermissions?: boolean },
	) => string[];
	buildEnv: (options: {
		filterPlugins?: boolean;
		allowAllPermissions?: boolean;
	}) => NodeJS.ProcessEnv;
	parseToolOutput: (line: string) => string | null;
	configName: string;
}

interface RunOptions {
	prompt: string;
	promptFile: string;
	model: string;
	agent: AgentType;
	iterations: number;
	tasksFile: string | null;
	milestone: string | null;
	workspace: string;
	repo: string | null;
	branch: string | null;
	done: string;
	next: string;
	timeout: number;
	force: boolean;
	verbose: boolean;
	quiet: boolean;
	noCommit: boolean;
	interactive: boolean;
	noPlugins: boolean;
	log: boolean;
}

// ============================================================================
// WebSocket Event Types
// ============================================================================

type ServerEvent =
	| {
			type: "loop.started";
			loopId: string;
			prompt: string;
			task?: StructuredTask;
	  }
	| { type: "iteration.started"; iteration: number; loopId: string }
	| { type: "iteration.completed"; iteration: number; result: IterationHistory }
	| {
			type: "task.updated";
			task: StructuredTask;
			taskId: string;
			status: string;
	  }
	| { type: "context.received"; text: string }
	| { type: "loop.completed"; history: RalphHistory; loopId: string }
	| { type: "loop.stopped"; reason: string; loopId: string; iteration: number }
	| { type: "error"; message: string };

// ============================================================================
// Globals
// ============================================================================

let workspaceRoot = process.cwd();
let structuredTasksFile: string | null = null;
let milestoneFilter: string | null = null;
let logFilePath: string | null = null;

// ============================================================================
// WebSocket Manager
// ============================================================================

import type { ServerWebSocket } from "bun";

type WSData = { id: string };

class WebSocketManager {
	private clients: Map<string, ServerWebSocket<WSData>> = new Map();
	private clientIdCounter = 0;

	generateClientId(): string {
		return `ws-${Date.now()}-${++this.clientIdCounter}`;
	}

	addClient(ws: ServerWebSocket<WSData>): void {
		this.clients.set(ws.data.id, ws);
		console.log(
			`[WS] Client connected: ${ws.data.id} (${this.clients.size} total)`,
		);
	}

	removeClient(ws: ServerWebSocket<WSData>): void {
		this.clients.delete(ws.data.id);
		console.log(
			`[WS] Client disconnected: ${ws.data.id} (${this.clients.size} total)`,
		);
	}

	broadcast(event: ServerEvent): void {
		const message = JSON.stringify(event);
		console.log(
			`[WS] Broadcasting ${event.type} to ${this.clients.size} client(s)`,
		);

		for (const [id, client] of this.clients) {
			try {
				client.send(message);
			} catch (err) {
				console.error(`[WS] Failed to send to ${id}:`, err);
				this.clients.delete(id);
			}
		}
	}

	getClientCount(): number {
		return this.clients.size;
	}
}

const wsManager = new WebSocketManager();

// ============================================================================
// Path helpers
// ============================================================================

const getStateDir = () => join(workspaceRoot, ".ralph");
const getStatePath = () => join(getStateDir(), "ralph-loop.state.json");
const getContextPath = () => join(getStateDir(), "ralph-context.md");
const getHistoryPath = () => join(getStateDir(), "ralph-history.json");
const getTasksPath = () => join(getStateDir(), "ralph-tasks.md");
const getSuggestedTasksPath = () => join(getStateDir(), "suggested-tasks.md");
const getLogDir = () => join(getStateDir(), "logs");
const getAssistContextPath = () => join(getStateDir(), "assist-context.md");

// ============================================================================
// Agent configurations
// ============================================================================

const AGENTS: Record<AgentType, AgentConfig> = {
	opencode: {
		type: "opencode",
		command: "opencode",
		buildArgs: (promptText, modelName) => {
			const args = ["run"];
			if (modelName) args.push("-m", modelName);
			args.push(promptText);
			return args;
		},
		buildEnv: (options) => {
			const env = { ...process.env };
			if (options.filterPlugins || options.allowAllPermissions) {
				env.OPENCODE_CONFIG = ensureRalphConfig(options);
			}
			return env;
		},
		parseToolOutput: (line) => {
			const match = stripAnsi(line).match(/^\|\s{2}([A-Za-z0-9_-]+)/);
			return match ? match[1] : null;
		},
		configName: "OpenCode",
	},
	"claude-code": {
		type: "claude-code",
		command: "claude",
		buildArgs: (promptText, modelName, options) => {
			const args = ["-p", promptText];
			if (modelName) args.push("--model", modelName);
			if (options?.allowAllPermissions)
				args.push("--dangerously-skip-permissions");
			return args;
		},
		buildEnv: () => ({ ...process.env }),
		parseToolOutput: (line) => {
			const match = stripAnsi(line).match(
				/(?:Using|Called|Tool:)\s+([A-Za-z0-9_-]+)/i,
			);
			return match ? match[1] : null;
		},
		configName: "Claude Code",
	},
	codex: {
		type: "codex",
		command: "codex",
		buildArgs: (promptText, modelName, options) => {
			const args = ["exec"];
			if (modelName) args.push("--model", modelName);
			if (options?.allowAllPermissions) args.push("--full-auto");
			args.push(promptText);
			return args;
		},
		buildEnv: () => ({ ...process.env }),
		parseToolOutput: (line) => {
			const match = stripAnsi(line).match(
				/(?:Tool:|Using|Calling|Running)\s+([A-Za-z0-9_-]+)/i,
			);
			return match ? match[1] : null;
		},
		configName: "Codex",
	},
};

// ============================================================================
// CLI Parser
// ============================================================================

interface ParsedArgs {
	command: string;
	args: string[];
	flags: Record<string, string | boolean>;
}

type FlagDef = { key: string; hasValue: boolean; default?: string };

const FLAG_DEFS: Record<string, FlagDef> = {
	"-h": { key: "help", hasValue: false },
	"--help": { key: "help", hasValue: false },
	"-V": { key: "version", hasValue: false },
	"--version": { key: "version", hasValue: false },
	"-f": { key: "prompt", hasValue: true },
	"--prompt": { key: "prompt", hasValue: true },
	"-n": { key: "iterations", hasValue: true, default: "0" },
	"--iterations": { key: "iterations", hasValue: true, default: "0" },
	"-m": { key: "model", hasValue: true },
	"--model": { key: "model", hasValue: true },
	"-a": { key: "agent", hasValue: true },
	"--agent": { key: "agent", hasValue: true },
	"-t": { key: "tasksFile", hasValue: true },
	"--tasks-file": { key: "tasksFile", hasValue: true },
	"-M": { key: "milestone", hasValue: true },
	"--milestone": { key: "milestone", hasValue: true },
	"-w": { key: "workspace", hasValue: true },
	"--workspace": { key: "workspace", hasValue: true },
	"--repo": { key: "repo", hasValue: true },
	"-b": { key: "branch", hasValue: true },
	"--branch": { key: "branch", hasValue: true },
	"--done": { key: "done", hasValue: true },
	"--next": { key: "next", hasValue: true },
	"--timeout": { key: "timeout", hasValue: true, default: "30" },
	"--force": { key: "force", hasValue: false },
	"-v": { key: "verbose", hasValue: false },
	"--verbose": { key: "verbose", hasValue: false },
	"-q": { key: "quiet", hasValue: false },
	"--quiet": { key: "quiet", hasValue: false },
	"--no-commit": { key: "noCommit", hasValue: false },
	"-i": { key: "interactive", hasValue: false },
	"--interactive": { key: "interactive", hasValue: false },
	"--no-plugins": { key: "noPlugins", hasValue: false },
	"--log": { key: "log", hasValue: false },
	"--no-log": { key: "noLog", hasValue: false },
	"--clear": { key: "clear", hasValue: false },
	"--json": { key: "json", hasValue: false },
	"-p": { key: "port", hasValue: true, default: "3456" },
	"--port": { key: "port", hasValue: true, default: "3456" },
	"--count": { key: "count", hasValue: true, default: "5" },
	"--lines": { key: "lines", hasValue: true, default: "1000" },
};

const COMMANDS = [
	"run",
	"serve",
	"status",
	"context",
	"tasks",
	"logs",
	"summary",
	"stop",
	"assist",
];

function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = { command: "", args: [], flags: {} };

	if (argv.length > 0 && COMMANDS.includes(argv[0])) {
		result.command = argv[0];
		argv = argv.slice(1);
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const def = FLAG_DEFS[arg];

		if (def) {
			result.flags[def.key] = def.hasValue
				? (argv[++i] ?? def.default ?? "")
				: true;
		} else if (arg.startsWith("-")) {
			console.error(`Unknown option: ${arg}`);
			console.error(`Run 'chief-wiggum --help' for usage`);
			process.exit(1);
		} else {
			result.args.push(arg);
		}
	}

	return result;
}

// ============================================================================
// Help text
// ============================================================================

const HELP_MAIN = `
Chief Wiggum v${VERSION} - Iterative AI development with Ralph loops

Usage:
  chief-wiggum [command] [options]

Commands:
  run              Start the Ralph loop (default)
  serve            Start HTTP server only (for OpenCode subagent mode)
  status           Show loop status and history  
  context <text>   Add context for next iteration
  tasks            List/manage tasks
  assist           Open opencode with loop context for manual help

Run 'chief-wiggum <command> --help' for command-specific help.

Examples:
  chief-wiggum run -f prompt.md -t docs/tasks.md -M M2b
  chief-wiggum status
  chief-wiggum context "focus on the auth module"
  chief-wiggum tasks add "fix the login bug"
  chief-wiggum assist
`;

const HELP_RUN = `
chief-wiggum run - Start the Ralph loop

Usage:
  chief-wiggum run [options] [prompt]
  chief-wiggum run                     # Uses docs/prompt.md and docs/tasks.md
  chief-wiggum -f <file> [options]

Defaults:
  If no prompt is provided, looks for docs/prompt.md
  If no tasks file is provided, looks for docs/tasks.md

Core Options:
  -f, --prompt <file>     Prompt file path (default: docs/prompt.md)
  -n, --iterations <n>    Max iterations (0=unlimited, default: 0)
  -m, --model <name>      Model to use (default: anthropic/claude-opus-4-5)
  -a, --agent <type>      Agent: opencode (default), claude-code, codex

Tasks:
  -t, --tasks-file <path> Structured tasks file (default: docs/tasks.md)
  -M, --milestone <name>  Filter by milestone (e.g., M2b)
  --done <phrase>         Completion promise (default: COMPLETE)
  --next <phrase>         Task promise (default: READY_FOR_NEXT_TASK)

Workspace:
  -w, --workspace <dir>   Working directory (default: current)
  --repo <path>           Git repo for worktree creation
  -b, --branch <name>     Branch name for worktree

Behavior:
  --timeout <mins>        Inactivity timeout (default: 30, 0=disable)
  --force                 Clear stale state and start fresh
  -v, --verbose           Verbose tool output
  -q, --quiet             Buffer output (no streaming)
  --no-commit             Disable auto-commit after iterations
  -i, --interactive       Require permission prompts (default: auto-approve)
  --no-plugins            Disable non-auth plugins (opencode only)
  --no-log                Disable logging to .ralph/logs/ (enabled by default)

Examples:
  chief-wiggum run                                    # Uses defaults
  chief-wiggum run -f prompt.md -t docs/tasks.md -M M2b -n 50
  chief-wiggum run "Fix the auth bug" --timeout 15
  chief-wiggum run -f prompt.md --force --no-log
`;

const HELP_STATUS = `
chief-wiggum status - Show Ralph loop status and history

Usage:
  chief-wiggum status [options]

Options:
  -w, --workspace <dir>   Check status in different directory

Examples:
  chief-wiggum status
  chief-wiggum status -w ~/projects/my-app
`;

const HELP_CONTEXT = `
chief-wiggum context - Add context for next Ralph iteration

Usage:
  chief-wiggum context <text>    Add context text
  chief-wiggum context --clear   Clear pending context

Options:
  -w, --workspace <dir>   Target different directory

Examples:
  chief-wiggum context "Focus on the auth module first"
  chief-wiggum context --clear
`;

const HELP_TASKS = `
chief-wiggum tasks - List and manage tasks

Usage:
  chief-wiggum tasks             List all tasks
  chief-wiggum tasks add <desc>  Add a new task
  chief-wiggum tasks rm <n>      Remove task by index

Options:
  -w, --workspace <dir>   Target different directory
  -t, --tasks-file <path> Specify tasks file

Examples:
  chief-wiggum tasks
  chief-wiggum tasks add "implement user login"
  chief-wiggum tasks rm 3
`;

const HELP_ASSIST = `
chief-wiggum assist - Open opencode with loop context for manual assistance

Usage:
  chief-wiggum assist [options]

Options:
  -w, --workspace <dir>   Target different directory
  -t, --tasks-file <path> Specify tasks file (default: docs/tasks.md)

Opens opencode with full context about the current loop including:
- The original prompt/goal
- Tasks file structure and current progress
- Loop state and iteration history
- Struggle indicators (repeated errors, stalled iterations)

Use this to:
- Add or modify tasks when the loop is struggling
- Inject guidance via 'chief-wiggum context'
- Fix issues directly in the codebase

Examples:
  chief-wiggum assist
  chief-wiggum assist -t docs/tasks.md
  chief-wiggum assist -w ~/projects/my-app
`;

// ============================================================================
// Utility functions
// ============================================================================

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes require control characters
const ANSI_REGEX = /\x1B\[[0-9;]*m/g;

function stripAnsi(input: string): string {
	return input.replace(ANSI_REGEX, "");
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0)
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDurationLong(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function killProcessTree(pid: number): Promise<void> {
	if (process.platform === "darwin" || process.platform === "linux") {
		// Use pkill to kill all processes in the process group
		try {
			await $`pkill -9 -P ${pid}`.quiet();
		} catch {}
		// Also try to kill the process directly
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	} else {
		// Windows or other - just try SIGKILL
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

// ============================================================================
// State management
// ============================================================================

function loadState(): RalphState | null {
	const path = getStatePath();
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function saveState(state: RalphState): void {
	const dir = getStateDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}

function clearState(): void {
	const path = getStatePath();
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {}
	}
}

function loadHistory(): RalphHistory {
	const path = getHistoryPath();
	if (!existsSync(path)) {
		return {
			iterations: [],
			totalDurationMs: 0,
			struggleIndicators: {
				repeatedErrors: {},
				noProgressIterations: 0,
				shortIterations: 0,
			},
		};
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {
			iterations: [],
			totalDurationMs: 0,
			struggleIndicators: {
				repeatedErrors: {},
				noProgressIterations: 0,
				shortIterations: 0,
			},
		};
	}
}

function saveHistory(history: RalphHistory): void {
	const dir = getStateDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(getHistoryPath(), JSON.stringify(history, null, 2));
}

function clearHistory(): void {
	const path = getHistoryPath();
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {}
	}
}

function loadContext(): string | null {
	const path = getContextPath();
	if (!existsSync(path)) return null;
	try {
		const content = readFileSync(path, "utf-8").trim();
		return content || null;
	} catch {
		return null;
	}
}

function clearContext(): void {
	const path = getContextPath();
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {}
	}
}

// ============================================================================
// Task parsing
// ============================================================================

function parseTasks(content: string): Task[] {
	const tasks: Task[] = [];
	const lines = content.split("\n");
	let currentTask: Task | null = null;

	for (const line of lines) {
		const topLevelMatch = line.match(/^- \[([ x/])\]\s*(.+)/);
		if (topLevelMatch) {
			if (currentTask) tasks.push(currentTask);
			const [, statusChar, text] = topLevelMatch;
			let status: Task["status"] = "todo";
			if (statusChar === "x") status = "complete";
			else if (statusChar === "/") status = "in-progress";
			currentTask = { text, status, subtasks: [], originalLine: line };
			continue;
		}

		const subtaskMatch = line.match(/^\s+- \[([ x/])\]\s*(.+)/);
		if (subtaskMatch && currentTask) {
			const [, statusChar, text] = subtaskMatch;
			let status: Task["status"] = "todo";
			if (statusChar === "x") status = "complete";
			else if (statusChar === "/") status = "in-progress";
			currentTask.subtasks.push({
				text,
				status,
				subtasks: [],
				originalLine: line,
			});
		}
	}

	if (currentTask) tasks.push(currentTask);
	return tasks;
}

function parseStructuredTasks(content: string): ParsedTasksFile {
	const milestones = new Map<string, StructuredTask[]>();
	const allTasks = new Map<string, StructuredTask>();
	const lines = content.split("\n");

	let currentMilestone: string | null = null;
	let currentTask: StructuredTask | null = null;
	let taskLines: string[] = [];

	const saveCurrentTask = () => {
		if (currentTask) {
			currentTask.originalLines = [...taskLines];
			allTasks.set(currentTask.id, currentTask);
			if (currentMilestone) {
				const tasks = milestones.get(currentMilestone) || [];
				tasks.push(currentTask);
				milestones.set(currentMilestone, tasks);
			}
		}
		currentTask = null;
		taskLines = [];
	};

	for (const line of lines) {
		const milestoneMatch = line.match(/^##\s+(\S+)(?::\s*(.*))?$/);
		if (milestoneMatch) {
			saveCurrentTask();
			currentMilestone = milestoneMatch[1];
			if (!milestones.has(currentMilestone))
				milestones.set(currentMilestone, []);
			continue;
		}

		const taskMatch = line.match(
			/^-\s+\[([ x/!])\]\s+([a-zA-Z0-9_-]+):\s*(.+)$/,
		);
		if (taskMatch) {
			saveCurrentTask();
			const [, statusChar, id, title] = taskMatch;
			let status: StructuredTask["status"] = "todo";
			if (statusChar === "x") status = "complete";
			else if (statusChar === "/") status = "in-progress";
			else if (statusChar === "!") status = "failed";

			currentTask = {
				id,
				title,
				milestone: currentMilestone,
				status,
				depends: [],
				verify: null,
				started: null,
				completed: null,
				failedReason: null,
				originalLines: [],
			};
			taskLines = [line];
			continue;
		}

		if (currentTask && line.match(/^\s+-\s+\w+:/)) {
			taskLines.push(line);

			const dependsMatch = line.match(/^\s+-\s+depends:\s*(.+)$/);
			if (dependsMatch) {
				currentTask.depends = dependsMatch[1].split(/[,\s]+/).filter(Boolean);
				continue;
			}

			const verifyMatch = line.match(/^\s+-\s+verify:\s*`?([^`]+)`?$/);
			if (verifyMatch) {
				currentTask.verify = verifyMatch[1].trim();
				continue;
			}

			const startedMatch = line.match(/^\s+-\s+started:\s*(.+)$/);
			if (startedMatch) {
				currentTask.started = startedMatch[1].trim();
				continue;
			}

			const completedMatch = line.match(/^\s+-\s+completed:\s*(.+)$/);
			if (completedMatch) {
				currentTask.completed = completedMatch[1].trim();
				continue;
			}

			const failedMatch = line.match(/^\s+-\s+failed:\s*(.+)$/);
			if (failedMatch) {
				currentTask.failedReason = failedMatch[1].trim();
			}
		}
	}

	saveCurrentTask();
	return { milestones, allTasks };
}

function loadStructuredTasks(): ParsedTasksFile | null {
	if (!structuredTasksFile) return null;
	const fullPath = join(workspaceRoot, structuredTasksFile);
	if (!existsSync(fullPath)) return null;
	try {
		return parseStructuredTasks(readFileSync(fullPath, "utf-8"));
	} catch {
		return null;
	}
}

function getNextStructuredTask(
	milestone: string | null,
): StructuredTask | null {
	const data = loadStructuredTasks();
	if (!data) return null;

	let tasks: StructuredTask[];
	if (milestone) {
		tasks = data.milestones.get(milestone) || [];
	} else {
		tasks = Array.from(data.allTasks.values());
	}

	function hasFailedDependency(taskId: string, visited: Set<string>): boolean {
		if (visited.has(taskId)) return false;
		visited.add(taskId);

		const task = data.allTasks.get(taskId);
		if (!task) return false;
		if (task.status === "failed") return true;

		for (const depId of task.depends) {
			if (hasFailedDependency(depId, visited)) return true;
		}
		return false;
	}

	function findIncompleteDepRecursive(
		taskId: string,
		visited: Set<string>,
	): StructuredTask | null {
		if (visited.has(taskId)) return null;
		visited.add(taskId);

		const task = data.allTasks.get(taskId);
		if (!task || task.status === "complete") return null;

		for (const depId of task.depends) {
			const dep = data.allTasks.get(depId);
			if (dep && dep.status !== "complete") {
				const deeperDep = findIncompleteDepRecursive(depId, visited);
				if (deeperDep) return deeperDep;
				return dep;
			}
		}

		return null;
	}

	for (const task of tasks) {
		if (task.status !== "todo" && task.status !== "in-progress") continue;

		if (hasFailedDependency(task.id, new Set())) continue;

		const incompleteDep = findIncompleteDepRecursive(task.id, new Set());
		if (incompleteDep) {
			if (incompleteDep.status === "failed") continue;
			return incompleteDep;
		}

		return task;
	}
	return null;
}

function allStructuredTasksComplete(milestone: string | null): boolean {
	const data = loadStructuredTasks();
	if (!data) return false;

	let tasks: StructuredTask[];
	if (milestone) {
		tasks = data.milestones.get(milestone) || [];
	} else {
		tasks = Array.from(data.allTasks.values());
	}

	return tasks.length > 0 && tasks.every((t) => t.status === "complete");
}

function isMilestoneFailed(milestone: string | null): {
	failed: boolean;
	failedTasks: StructuredTask[];
	blockedTasks: StructuredTask[];
} {
	const data = loadStructuredTasks();
	if (!data) return { failed: false, failedTasks: [], blockedTasks: [] };

	let tasks: StructuredTask[];
	if (milestone) {
		tasks = data.milestones.get(milestone) || [];
	} else {
		tasks = Array.from(data.allTasks.values());
	}

	const failedTasks = tasks.filter((t) => t.status === "failed");
	if (failedTasks.length === 0)
		return { failed: false, failedTasks: [], blockedTasks: [] };

	function hasFailedDep(taskId: string, visited: Set<string>): boolean {
		if (visited.has(taskId)) return false;
		visited.add(taskId);
		const task = data.allTasks.get(taskId);
		if (!task) return false;
		if (task.status === "failed") return true;
		for (const depId of task.depends) {
			if (hasFailedDep(depId, visited)) return true;
		}
		return false;
	}

	const blockedTasks = tasks.filter(
		(t) =>
			t.status !== "complete" &&
			t.status !== "failed" &&
			hasFailedDep(t.id, new Set()),
	);

	const workable = tasks.filter(
		(t) =>
			(t.status === "todo" || t.status === "in-progress") &&
			!hasFailedDep(t.id, new Set()),
	);

	return {
		failed: workable.length === 0,
		failedTasks,
		blockedTasks,
	};
}

function getStructuredTasksSummary(milestone: string | null): {
	pending: number;
	inProgress: number;
	completed: number;
	failed: number;
	blocked: number;
	total: number;
} {
	const data = loadStructuredTasks();
	if (!data)
		return {
			pending: 0,
			inProgress: 0,
			completed: 0,
			failed: 0,
			blocked: 0,
			total: 0,
		};

	let tasks: StructuredTask[];
	if (milestone) {
		tasks = data.milestones.get(milestone) || [];
	} else {
		tasks = Array.from(data.allTasks.values());
	}

	function hasFailedDep(taskId: string, visited: Set<string>): boolean {
		if (visited.has(taskId)) return false;
		visited.add(taskId);
		const task = data.allTasks.get(taskId);
		if (!task) return false;
		if (task.status === "failed") return true;
		for (const depId of task.depends) {
			if (hasFailedDep(depId, visited)) return true;
		}
		return false;
	}

	const failed = tasks.filter((t) => t.status === "failed").length;
	const blocked = tasks.filter(
		(t) =>
			t.status !== "complete" &&
			t.status !== "failed" &&
			hasFailedDep(t.id, new Set()),
	).length;
	const pending = tasks.filter((t) => t.status === "todo").length - blocked;
	const inProgress = tasks.filter((t) => t.status === "in-progress").length;
	const completed = tasks.filter((t) => t.status === "complete").length;
	return {
		pending: Math.max(0, pending),
		inProgress,
		completed,
		failed,
		blocked,
		total: tasks.length,
	};
}

function _findCurrentTask(tasks: Task[]): Task | null {
	for (const task of tasks) {
		if (task.status === "in-progress") return task;
	}
	return null;
}

function _findNextTask(tasks: Task[]): Task | null {
	for (const task of tasks) {
		if (task.status === "todo") return task;
	}
	return null;
}

function _allTasksComplete(tasks: Task[]): boolean {
	return tasks.length > 0 && tasks.every((t) => t.status === "complete");
}

// ============================================================================
// Assist context builder
// ============================================================================

function buildAssistContext(): string {
	const state = loadState();
	const history = loadHistory();
	const context = loadContext();
	const tasksData = loadStructuredTasks();
	const tasksFile = structuredTasksFile || "docs/tasks.md";

	let md = `# Ralph Loop Assistant

## Your Role

Help manage and debug a Ralph development loop. You can:
- Add or modify tasks in \`${tasksFile}\`
- Inject context via \`chief-wiggum context "your guidance here"\`
- Fix issues directly in the codebase

The loop will pick up your changes on its next iteration.

`;

	// Original goal/prompt
	if (state?.prompt) {
		md += `## Original Goal

${state.prompt}

`;
	}

	// Tasks file info
	md += `## Tasks File: \`${tasksFile}\`

Tasks use this format:
\`\`\`markdown
## MilestoneName

- [ ] task-id: Task title
  - depends: other-task-id
  - verify: \`npm test\`
\`\`\`

Status markers: \`[ ]\` = todo, \`[/]\` = in-progress, \`[x]\` = complete

`;

	// Task progress
	if (tasksData) {
		const summary = getStructuredTasksSummary(milestoneFilter);
		const nextTask = getNextStructuredTask(milestoneFilter);

		md += `### Progress

`;
		if (milestoneFilter) {
			md += `Milestone: **${milestoneFilter}**\n`;
		}
		md += `- ${summary.completed}/${summary.total} complete
- ${summary.inProgress} in-progress
- ${summary.pending} pending

`;

		if (nextTask) {
			md += `### Current Task

**${nextTask.id}**: ${nextTask.title}
`;
			if (nextTask.verify) {
				md += `- Verify: \`${nextTask.verify}\`\n`;
			}
			if (nextTask.depends.length > 0) {
				md += `- Depends on: ${nextTask.depends.join(", ")}\n`;
			}
			md += "\n";
		}

		// All tasks list
		md += `### All Tasks

`;
		for (const [milestone, tasks] of tasksData.milestones) {
			const complete = tasks.filter((t) => t.status === "complete").length;
			md += `**${milestone}** (${complete}/${tasks.length})\n`;
			for (const task of tasks) {
				const icon =
					task.status === "complete"
						? "[x]"
						: task.status === "in-progress"
							? "[/]"
							: "[ ]";
				md += `- ${icon} ${task.id}: ${task.title}\n`;
			}
			md += "\n";
		}
	} else {
		md += `### No structured tasks file found

Create one at \`${tasksFile}\` or specify with \`-t <path>\`.

`;
	}

	// Loop status
	md += `## Loop Status

`;
	if (state?.active) {
		const elapsed = Date.now() - new Date(state.startedAt).getTime();
		md += `- **Active**: Yes
- **Iteration**: ${state.iteration}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : " (unlimited)"}
- **Started**: ${state.startedAt}
- **Elapsed**: ${formatDurationLong(elapsed)}
- **Agent**: ${state.agent ? (AGENTS[state.agent]?.configName ?? state.agent) : "OpenCode"}
- **Model**: ${state.model || "default"}

`;
	} else {
		md += `- **Active**: No

No loop is currently running. Start one with:
\`\`\`bash
chief-wiggum run -f prompt.md -t ${tasksFile}
\`\`\`

`;
	}

	// History summary
	if (history.iterations.length > 0) {
		md += `## History Summary

- **Total iterations**: ${history.iterations.length}
- **Total time**: ${formatDurationLong(history.totalDurationMs)}

### Recent Iterations (last 5)

`;
		const recent = history.iterations.slice(-5);
		for (const iter of recent) {
			const tools = Object.entries(iter.toolsUsed)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 4)
				.map(([k, v]) => `${k}:${v}`)
				.join(", ");
			const status = iter.completionDetected
				? "completed"
				: iter.exitCode !== 0
					? "error"
					: "continued";
			const files =
				iter.filesModified.length > 0
					? `${iter.filesModified.length} files`
					: "no files";

			md += `**#${iter.iteration}** (${formatDurationLong(iter.durationMs)}) - ${status}
- Tools: ${tools || "none"}
- Modified: ${files}
`;
			if (iter.errors.length > 0) {
				md += `- Errors: ${iter.errors.slice(0, 2).join("; ").substring(0, 100)}${iter.errors.length > 2 ? "..." : ""}\n`;
			}
			md += "\n";
		}

		// Struggle indicators
		const struggles = history.struggleIndicators;
		if (
			struggles.noProgressIterations > 0 ||
			struggles.shortIterations > 0 ||
			Object.keys(struggles.repeatedErrors).length > 0
		) {
			md += `### Struggle Indicators

`;
			if (struggles.noProgressIterations > 0) {
				md += `- **No-progress iterations**: ${struggles.noProgressIterations} consecutive\n`;
			}
			if (struggles.shortIterations > 0) {
				md += `- **Short iterations** (<30s): ${struggles.shortIterations} consecutive\n`;
			}
			if (Object.keys(struggles.repeatedErrors).length > 0) {
				md += `- **Repeated errors**:\n`;
				for (const [error, count] of Object.entries(struggles.repeatedErrors)) {
					md += `  - (${count}x) ${error.substring(0, 80)}${error.length > 80 ? "..." : ""}\n`;
				}
			}
			md += "\n";
		}
	}

	// Pending context
	md += `## Pending Context

`;
	if (context) {
		md += `The following context will be included in the next iteration:

${context}
`;
	} else {
		md += `None. Add context with:
\`\`\`bash
chief-wiggum context "Your guidance or hint here"
\`\`\`
`;
	}

	return md;
}

// ============================================================================
// Config helpers
// ============================================================================

function loadPluginsFromConfig(configPath: string): string[] {
	if (!existsSync(configPath)) return [];
	try {
		const raw = readFileSync(configPath, "utf-8");
		const withoutBlock = raw.replace(/\/\*[\s\S]*?\*\//g, "");
		const withoutLine = withoutBlock.replace(/^\s*\/\/.*$/gm, "");
		const parsed = JSON.parse(withoutLine);
		const plugins = parsed?.plugin;
		return Array.isArray(plugins)
			? plugins.filter((p) => typeof p === "string")
			: [];
	} catch {
		return [];
	}
}

function ensureRalphConfig(options: {
	filterPlugins?: boolean;
	allowAllPermissions?: boolean;
}): string {
	const stateDir = getStateDir();
	if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

	const configPath = join(stateDir, "ralph-opencode.config.json");
	const userConfigPath = join(
		process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
		"opencode",
		"opencode.json",
	);
	const projectConfigPath = join(process.cwd(), ".ralph", "opencode.json");
	const legacyProjectConfigPath = join(
		process.cwd(),
		".opencode",
		"opencode.json",
	);

	const config: Record<string, unknown> = {
		$schema: "https://opencode.ai/config.json",
	};

	if (options.filterPlugins) {
		const plugins = [
			...loadPluginsFromConfig(userConfigPath),
			...loadPluginsFromConfig(projectConfigPath),
			...loadPluginsFromConfig(legacyProjectConfigPath),
		];
		config.plugin = Array.from(new Set(plugins)).filter((p) => /auth/i.test(p));
	}

	if (options.allowAllPermissions) {
		config.permission = {
			read: "allow",
			edit: "allow",
			glob: "allow",
			grep: "allow",
			list: "allow",
			bash: "allow",
			task: "allow",
			webfetch: "allow",
			websearch: "allow",
			codesearch: "allow",
			todowrite: "allow",
			todoread: "allow",
			question: "allow",
			lsp: "allow",
			external_directory: "allow",
		};
	}

	writeFileSync(configPath, JSON.stringify(config, null, 2));
	return configPath;
}

// ============================================================================
// Worktree management
// ============================================================================

function extractWorktreeName(promptContent: string): string {
	const match = promptContent.match(/^#\s+(.+)$/m);
	if (!match) {
		console.error("Error: No # heading found in prompt file.");
		process.exit(1);
	}
	return match[1]
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
	try {
		const localResult =
			await $`git -C ${repoDir} branch --list ${branch}`.text();
		if (localResult.trim()) return true;
		const remoteResult =
			await $`git -C ${repoDir} branch -r --list origin/${branch}`.text();
		return !!remoteResult.trim();
	} catch {
		return false;
	}
}

async function getDefaultBranch(repoDir: string): Promise<string> {
	try {
		const result =
			await $`git -C ${repoDir} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`.text();
		const match = result.match(/refs\/remotes\/origin\/(.+)/);
		if (match) return match[1].trim();
	} catch {}

	try {
		await $`git -C ${repoDir} rev-parse --verify origin/main`.quiet();
		return "main";
	} catch {
		try {
			await $`git -C ${repoDir} rev-parse --verify origin/master`.quiet();
			return "master";
		} catch {
			console.error("Error: Could not find origin/main or origin/master");
			process.exit(1);
		}
	}
	return "main";
}

async function confirm(message: string): Promise<boolean> {
	process.stdout.write(`${message} [y/N] `);
	const reader = Bun.stdin.stream().getReader();
	const { value } = await reader.read();
	reader.releaseLock();
	const answer = new TextDecoder().decode(value).trim().toLowerCase();
	return answer === "y" || answer === "yes";
}

async function setupWorktree(
	repo: string,
	promptContent: string,
	branch: string | null,
	promptFilePath: string,
	tasksFilePath: string | null,
): Promise<{
	worktreePath: string;
	promptFile: string;
	tasksFile: string | null;
}> {
	if (!existsSync(join(repo, ".git"))) {
		console.error(`Error: Not a git repository: ${repo}`);
		process.exit(1);
	}

	const worktreeName = extractWorktreeName(promptContent);
	const worktreePath = `${repo}.worktrees/${worktreeName}`;
	const effectiveBranch = branch || worktreeName;

	console.log(`\n📁 Worktree Setup`);
	console.log(`   Name: ${worktreeName}`);
	console.log(`   Path: ${worktreePath}`);
	console.log(`   Branch: ${effectiveBranch}`);

	if (existsSync(worktreePath)) {
		console.log(`   Status: Using existing worktree`);
		return {
			worktreePath,
			promptFile: join(worktreePath, ".ralph", "ralph-prompt.md"),
			tasksFile: tasksFilePath,
		};
	}

	console.log(`   Fetching from origin...`);
	try {
		await $`git -C ${repo} fetch origin`.quiet();
	} catch {}

	const branchAlreadyExists = await branchExists(repo, effectiveBranch);

	if (branchAlreadyExists) {
		console.log(`   Branch '${effectiveBranch}' already exists.`);
		const confirmed = await confirm(`   Reuse existing branch?`);
		if (!confirmed) {
			console.error("   Aborted. Specify a different branch with -b");
			process.exit(1);
		}
		await $`git -C ${repo} worktree add ${worktreePath} ${effectiveBranch}`;
	} else {
		const defaultBranch = await getDefaultBranch(repo);
		console.log(`   Creating new branch from origin/${defaultBranch}...`);
		const worktreeParent = join(`${repo}.worktrees`);
		if (!existsSync(worktreeParent))
			mkdirSync(worktreeParent, { recursive: true });
		await $`git -C ${repo} worktree add -b ${effectiveBranch} ${worktreePath} origin/${defaultBranch}`;
	}

	const ralphDir = join(worktreePath, ".ralph");
	if (!existsSync(ralphDir)) mkdirSync(ralphDir, { recursive: true });

	const targetPromptPath = join(ralphDir, "ralph-prompt.md");
	copyFileSync(promptFilePath, targetPromptPath);
	console.log(`   Copied prompt to .ralph/ralph-prompt.md`);

	let finalTasksFile: string | null = null;
	if (tasksFilePath && existsSync(tasksFilePath)) {
		const targetTasksPath = join(worktreePath, tasksFilePath);
		const targetTasksDir = join(
			worktreePath,
			...tasksFilePath.split("/").slice(0, -1),
		);
		if (targetTasksDir && !existsSync(targetTasksDir))
			mkdirSync(targetTasksDir, { recursive: true });
		copyFileSync(tasksFilePath, targetTasksPath);
		console.log(`   Copied tasks to ${tasksFilePath}`);
		finalTasksFile = tasksFilePath;
	}

	console.log(`   ✅ Worktree ready`);

	return {
		worktreePath,
		promptFile: ".ralph/ralph-prompt.md",
		tasksFile: finalTasksFile,
	};
}

// ============================================================================
// Logging
// ============================================================================

function initLogFile(): void {
	if (!logFilePath) return;

	const logDir = getLogDir();
	if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const milestone = milestoneFilter || "all";
	logFilePath = join(logDir, `${milestone}-${timestamp}.log`);

	writeFileSync(
		logFilePath,
		`==========================================
Ralph Wiggum Session Log
==========================================
Started:      ${new Date().toLocaleString()}
Milestone:    ${milestoneFilter || "ALL"}
Working Dir:  ${workspaceRoot}
Tasks File:   ${structuredTasksFile || "N/A"}
==========================================

`,
	);
}

function appendToLog(text: string): void {
	if (!logFilePath) return;
	appendFileSync(logFilePath, text);
}

// ============================================================================
// Log analysis
// ============================================================================

interface IterationSummary {
	number: number;
	duration: string;
	tools: Record<string, number>;
	exitCode: number | null;
	completed: boolean;
	taskId: string | null;
}

interface LogAnalysis {
	iterations: number;
	totalDuration: string;
	totalDurationSeconds: number;
	avgIterationSeconds: number;
	tasksCompleted: string[];
	tasksStarted: string[];
	toolUsage: Record<string, number>;
	totalToolCalls: number;
	errors: Array<{ error: string; count: number; firstSeen: string }>;
	repeatedPatterns: Array<{
		pattern: string;
		count: number;
		suggestion: string;
	}>;
	suggestions: string[];
	iterationDetails: IterationSummary[];
	filesModified: string[];
	completionRate: number;
	avgToolsPerIteration: number;
}

function analyzeLogContent(content: string): LogAnalysis {
	// Parse individual iterations
	const iterationDetails: IterationSummary[] = [];
	const iterationRegex = /🔄 Iteration (\d+)[\s\S]*?(?=🔄 Iteration \d+|$)/g;

	for (const iterMatch of content.matchAll(iterationRegex)) {
		const iterContent = iterMatch[0];
		const iterNum = parseInt(iterMatch[1], 10);

		// Extract duration
		const durationMatch = iterContent.match(/Elapsed:\s+(\d+):(\d+)/);
		const duration = durationMatch
			? `${durationMatch[1]}:${durationMatch[2]}`
			: "0:00";

		// Extract tools from summary line like "Tools:     Read 10 • Bash 8 • Edit 1"
		const tools: Record<string, number> = {};
		const toolsMatch = iterContent.match(/Tools:\s+([^\n]+)/);
		if (toolsMatch && toolsMatch[1] !== "none") {
			const toolParts = toolsMatch[1].split("•").map((s) => s.trim());
			for (const part of toolParts) {
				const [name, countStr] = part.split(/\s+/);
				if (name && countStr) {
					tools[name] = parseInt(countStr, 10) || 0;
				}
			}
		}

		// Extract exit code
		const exitMatch = iterContent.match(/Exit code:\s+(\d+)/);
		const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;

		// Check if completion detected
		const completed = /Completion:\s+detected/i.test(iterContent);

		// Extract task ID if mentioned
		const taskMatch =
			iterContent.match(/Next:\s+(m\d+-\d+)/i) ||
			iterContent.match(/task\s+(m\d+-\d+)/i);
		const taskId = taskMatch ? taskMatch[1] : null;

		iterationDetails.push({
			number: iterNum,
			duration,
			tools,
			exitCode,
			completed,
			taskId,
		});
	}

	const iterations = iterationDetails.length;

	// Calculate total duration
	let totalSeconds = 0;
	for (const iter of iterationDetails) {
		const [mins, secs] = iter.duration.split(":").map(Number);
		totalSeconds += (mins || 0) * 60 + (secs || 0);
	}
	const totalMins = Math.floor(totalSeconds / 60);
	const totalSecs = totalSeconds % 60;
	const totalDuration = `${totalMins}:${String(totalSecs).padStart(2, "0")}`;
	const avgIterationSeconds =
		iterations > 0 ? Math.round(totalSeconds / iterations) : 0;

	// Aggregate tool usage
	const toolUsage: Record<string, number> = {};
	for (const iter of iterationDetails) {
		for (const [tool, count] of Object.entries(iter.tools)) {
			toolUsage[tool] = (toolUsage[tool] || 0) + count;
		}
	}
	const totalToolCalls = Object.values(toolUsage).reduce((a, b) => a + b, 0);
	const avgToolsPerIteration =
		iterations > 0 ? Math.round(totalToolCalls / iterations) : 0;

	// Extract completed tasks
	const tasksCompleted: string[] = [];
	const taskCompleteRegex =
		/(?:completed?|done|finished|mark.*complete|✅).*?(m\d+-\d+)/gi;
	for (const taskMatch of content.matchAll(taskCompleteRegex)) {
		const taskId = taskMatch[1].toLowerCase();
		if (!tasksCompleted.includes(taskId)) {
			tasksCompleted.push(taskId);
		}
	}

	// Extract started tasks
	const tasksStarted: string[] = [];
	const taskStartRegex = /(?:start|working on|begin|task).*?(m\d+-\d+)/gi;
	for (const taskMatch of content.matchAll(taskStartRegex)) {
		const taskId = taskMatch[1].toLowerCase();
		if (!tasksStarted.includes(taskId) && !tasksCompleted.includes(taskId)) {
			tasksStarted.push(taskId);
		}
	}

	// Extract modified files
	const filesModified: string[] = [];
	const fileModRegex =
		/(?:Edit|Write|modified|created|updated)\s+(?:\d+\s+)?([/\w.-]+\.\w+)/gi;
	for (const fileMatch of content.matchAll(fileModRegex)) {
		const file = fileMatch[1];
		if (!filesModified.includes(file) && !file.includes("ralph")) {
			filesModified.push(file);
		}
	}

	// Count errors with context
	const errorCounts = new Map<string, { count: number; firstSeen: string }>();
	const errorPatterns = [
		/error:\s*(.{10,100})/gi,
		/failed:\s*(.{10,100})/gi,
		/exception:\s*(.{10,100})/gi,
		/TypeError:\s*(.{10,80})/gi,
		/SyntaxError:\s*(.{10,80})/gi,
		/ReferenceError:\s*(.{10,80})/gi,
		/ENOENT:\s*(.{10,80})/gi,
		/EADDRINUSE:\s*(.{10,80})/gi,
	];
	for (const pattern of errorPatterns) {
		for (const match of content.matchAll(pattern)) {
			const error = match[1].trim().substring(0, 100);
			if (!errorCounts.has(error)) {
				// Find iteration context
				const pos = match.index || 0;
				const before = content.substring(Math.max(0, pos - 500), pos);
				const iterMatch = before.match(/🔄 Iteration (\d+)/g);
				const firstSeen = iterMatch
					? `Iteration ${iterMatch[iterMatch.length - 1]?.match(/\d+/)?.[0]}`
					: "Unknown";
				errorCounts.set(error, { count: 1, firstSeen });
			} else {
				const existing = errorCounts.get(error);
				if (existing) existing.count++;
			}
		}
	}
	const errors = Array.from(errorCounts.entries())
		.map(([error, data]) => ({
			error,
			count: data.count,
			firstSeen: data.firstSeen,
		}))
		.sort((a, b) => b.count - a.count)
		.slice(0, 15);

	// Calculate completion rate
	const completedIterations = iterationDetails.filter(
		(i) => i.completed,
	).length;
	const completionRate =
		iterations > 0 ? Math.round((completedIterations / iterations) * 100) : 0;

	// Detect repeated patterns that suggest prompt improvements
	const repeatedPatterns: Array<{
		pattern: string;
		count: number;
		suggestion: string;
	}> = [];
	const suggestions: string[] = [];

	// Pattern: Checking test files multiple times
	const testCheckMatches =
		content.match(
			/(?:run.*test|bun test|npm test|nx.*test|checking.*test|test.*pass|test.*fail)/gi,
		) || [];
	if (testCheckMatches.length > 3) {
		repeatedPatterns.push({
			pattern: "Test execution",
			count: testCheckMatches.length,
			suggestion: "Add test commands and expected patterns to prompt file",
		});
		suggestions.push(
			`Tests were run/checked ${testCheckMatches.length} times. Add 'nx test <project>' commands to the prompt file so the agent knows exactly how to run tests.`,
		);
	}

	// Pattern: Reading same file multiple times
	const fileReadCounts = new Map<string, number>();
	const fileReadRegex = /(?:Read|Reading).*?([/\w.-]+\.\w+)/gi;
	for (const fileMatch of content.matchAll(fileReadRegex)) {
		const file = fileMatch[1];
		fileReadCounts.set(file, (fileReadCounts.get(file) || 0) + 1);
	}
	const frequentReads = Array.from(fileReadCounts.entries())
		.filter(([_, count]) => count > 4)
		.sort((a, b) => b[1] - a[1]);
	for (const [file, count] of frequentReads.slice(0, 5)) {
		repeatedPatterns.push({
			pattern: `Reading ${file}`,
			count,
			suggestion: `Add key content from this file to prompt or context`,
		});
	}
	if (frequentReads.length > 0) {
		suggestions.push(
			`Files read repeatedly: ${frequentReads
				.slice(0, 3)
				.map(([f, c]) => `${f} (${c}x)`)
				.join(", ")}. Consider adding their key content to the prompt.`,
		);
	}

	// Pattern: Searching for same thing multiple times
	const searchCounts = new Map<string, number>();
	const searchRegex =
		/(?:grep|Grep|search|find|looking for|searching).*?["']([^"']{3,50})["']/gi;
	for (const searchMatch of content.matchAll(searchRegex)) {
		const term = searchMatch[1].substring(0, 50);
		searchCounts.set(term, (searchCounts.get(term) || 0) + 1);
	}
	const frequentSearches = Array.from(searchCounts.entries())
		.filter(([_, count]) => count > 2)
		.sort((a, b) => b[1] - a[1]);
	for (const [term, count] of frequentSearches.slice(0, 5)) {
		repeatedPatterns.push({
			pattern: `Searching "${term.substring(0, 30)}"`,
			count,
			suggestion: `Add file locations for "${term.substring(0, 20)}" to prompt`,
		});
	}

	// Pattern: Same error occurring multiple times
	for (const { error, count } of errors) {
		if (count > 2) {
			suggestions.push(
				`Error "${error.substring(0, 50)}..." occurred ${count} times. Add specific fix instructions to prompt.`,
			);
		}
	}

	// Pattern: Git operations repeated
	const gitMatches =
		content.match(/git (?:add|commit|push|status|diff)/gi) || [];
	if (gitMatches.length > 15) {
		repeatedPatterns.push({
			pattern: "Git operations",
			count: gitMatches.length,
			suggestion: "Many git operations. Consider batching commits.",
		});
	}

	// Pattern: Server start/restart
	const serverMatches =
		content.match(
			/(?:nx serve|npm start|starting server|server.*running|listening on port)/gi,
		) || [];
	if (serverMatches.length > 5) {
		repeatedPatterns.push({
			pattern: "Server start/restart",
			count: serverMatches.length,
			suggestion:
				"Server started many times. Add instructions to check if already running.",
		});
	}

	// Pattern: Build commands
	const buildMatches =
		content.match(/(?:nx build|npm run build|bun build|building|compiled)/gi) ||
		[];
	if (buildMatches.length > 10) {
		repeatedPatterns.push({
			pattern: "Build commands",
			count: buildMatches.length,
			suggestion: "Many builds. Consider when builds are actually needed.",
		});
	}

	// Low completion rate warning
	if (iterations > 5 && completionRate < 20) {
		suggestions.push(
			`Low task completion rate (${completionRate}%). Tasks may be too large or unclear. Consider breaking into smaller tasks.`,
		);
	}

	// Long average iteration time
	if (avgIterationSeconds > 180) {
		suggestions.push(
			`Average iteration takes ${Math.round(avgIterationSeconds / 60)} minutes. Consider adding more specific instructions to speed up.`,
		);
	}

	return {
		iterations,
		totalDuration,
		totalDurationSeconds: totalSeconds,
		avgIterationSeconds,
		tasksCompleted,
		tasksStarted,
		toolUsage,
		totalToolCalls,
		errors,
		repeatedPatterns,
		suggestions,
		iterationDetails: iterationDetails.slice(-20), // Last 20 iterations
		filesModified,
		completionRate,
		avgToolsPerIteration,
	};
}

// ============================================================================
// Suggested tasks
// ============================================================================

function parseSuggestedTasks(
	output: string,
): Array<{ task: string; milestone: string | null }> {
	const suggestions: Array<{ task: string; milestone: string | null }> = [];
	const regex =
		/<suggest-task(?:\s+milestone="([^"]*)")?\s*>([\s\S]*?)<\/suggest-task>/g;
	let match: RegExpExecArray | null = regex.exec(output);
	while (match !== null) {
		const milestone = match[1] || null;
		const task = match[2].trim();
		if (task) suggestions.push({ task, milestone });
		match = regex.exec(output);
	}
	return suggestions;
}

function appendSuggestedTasks(
	suggestions: Array<{ task: string; milestone: string | null }>,
	iteration: number,
): void {
	if (suggestions.length === 0) return;

	const suggestedPath = getSuggestedTasksPath();
	const timestamp = new Date().toISOString();

	let content = "";
	if (existsSync(suggestedPath)) {
		content = readFileSync(suggestedPath, "utf-8");
	} else {
		content =
			"# Suggested Tasks\n\nTasks suggested by the Ralph loop agent for review.\n\n";
	}

	content += `\n## From Iteration ${iteration} (${timestamp})\n\n`;
	for (const { task, milestone } of suggestions) {
		if (milestone) {
			content += `- [ ] ${task}\n  - suggested-milestone: ${milestone}\n`;
		} else {
			content += `- [ ] ${task}\n`;
		}
	}

	writeFileSync(suggestedPath, content);
	console.log(
		`📝 ${suggestions.length} task suggestion(s) written to .ralph/suggested-tasks.md`,
	);
}

// ============================================================================
// Prompt building
// ============================================================================

function buildPrompt(state: RalphState, _agent: AgentConfig): string {
	const context = loadContext();
	const contextSection = context
		? `
## Additional Context (added by user mid-loop)

${context}

---
`
		: "";

	if (state.structuredTasksFile) {
		const summary = getStructuredTasksSummary(state.milestoneFilter);
		const nextTask = getNextStructuredTask(state.milestoneFilter);
		const allComplete = allStructuredTasksComplete(state.milestoneFilter);
		const milestoneFailure = isMilestoneFailed(state.milestoneFilter);

		const data = loadStructuredTasks();
		let tasks: StructuredTask[] = [];
		if (data) {
			if (state.milestoneFilter) {
				tasks = data.milestones.get(state.milestoneFilter) || [];
			} else {
				tasks = Array.from(data.allTasks.values());
			}
		}

		const blockedIds = new Set(milestoneFailure.blockedTasks.map((t) => t.id));

		const statusIcons: Record<string, string> = {
			complete: "✅",
			failed: "❌",
			"in-progress": "🔄",
			todo: "⏸️",
		};

		const taskList = tasks
			.map((t) => {
				const icon = blockedIds.has(t.id) ? "🚫" : statusIcons[t.status] || "⏸️";
				const deps = t.depends.length
					? ` (depends: ${t.depends.join(", ")})`
					: "";
				const reason =
					t.status === "failed" && t.failedReason ? ` — ${t.failedReason}` : "";
				return `${icon} ${t.id}: ${t.title}${deps}${reason}`;
			})
			.join("\n");

		const summaryLine = `${summary.completed}/${summary.total} complete, ${summary.inProgress} in progress, ${summary.pending} pending${summary.failed > 0 ? `, ${summary.failed} failed` : ""}${summary.blocked > 0 ? `, ${summary.blocked} blocked` : ""}`;

		let taskInstructions = "";
		if (milestoneFailure.failed && !allComplete) {
			const failedNames = milestoneFailure.failedTasks
				.map((t) => t.id)
				.join(", ");
			const blockedNames = milestoneFailure.blockedTasks
				.map((t) => t.id)
				.join(", ");
			taskInstructions = `
❌ MILESTONE FAILED
   Failed tasks: ${failedNames}
   ${blockedNames ? `Blocked tasks: ${blockedNames}` : ""}
   No remaining workable tasks. Output <promise>MILESTONE_FAILED</promise> to signal failure.`;
		} else if (allComplete) {
			taskInstructions = `\n✅ ALL TASKS COMPLETE!\n   Output <promise>${state.completionPromise}</promise> to finish.`;
		} else if (nextTask) {
			taskInstructions = `
📍 NEXT TASK: ${nextTask.id}
   Title: "${nextTask.title}"
   ${nextTask.verify ? `Verify: \`${nextTask.verify}\`` : ""}
   ${nextTask.depends.length ? `Dependencies: ${nextTask.depends.join(", ")} (all completed)` : ""}
   
   1. Change [ ] to [/] for this task in ${state.structuredTasksFile}
   2. Add "- started: ${new Date().toISOString()}" under the task
   3. Complete the work
   4. Run verification: ${nextTask.verify || "(no verification command)"}
   5. Change [/] to [x] and add "- completed: <timestamp>"
   6. Commit changes
   7. Output <promise>${state.taskPromise}</promise>`;
		} else {
			taskInstructions = `\n⏳ No available tasks. Check dependencies - some tasks may be blocked.`;
		}

		return `
# Ralph Wiggum Loop - Iteration ${state.iteration}

You are in an iterative development loop working through a structured task list.
${contextSection}
## STRUCTURED TASKS MODE: ${state.milestoneFilter ? `Milestone ${state.milestoneFilter}` : "All Tasks"}

**Summary:** ${summaryLine}

**Tasks:**
${taskList}
${taskInstructions}

## Your Main Goal

${state.prompt}

## Critical Rules

- Work on ONE task at a time from ${state.structuredTasksFile}
- When starting a task: change [ ] to [/] and add "- started: <ISO timestamp>"
- When completing a task: change [/] to [x] and add "- completed: <ISO timestamp>"
- Run the verification command in the task's "verify" field before marking complete
- Commit your changes after completing each task
- ONLY output <promise>${state.taskPromise}</promise> when the current task is verified complete
- ONLY output <promise>${state.completionPromise}</promise> when ALL tasks for milestone ${state.milestoneFilter || "ALL"} are complete
- Do NOT lie or output false promises to exit the loop
- If stuck, try a different approach

## Failing a Task

If a task requires going against your given instructions or is truly impossible:
1. Change the task status from [ ] or [/] to [!] in ${state.structuredTasksFile}
2. Add "- failed: <reason>" under the task explaining why
3. Output <promise>${state.taskPromise}</promise> to move on
4. Tasks that depend on a failed task will be automatically skipped

## Performance Tips

- Use grep/ripgrep directly for searches - do NOT use the Task tool for simple find/search operations
- Prefer Bash commands over spawning sub-agents
- Keep iterations fast - avoid unnecessary tool calls

## Suggesting New Tasks

If you discover work that should be done but isn't in the task list, suggest it:

\`\`\`
<suggest-task>Description of the task that should be added</suggest-task>
<suggest-task milestone="M2b">Task for a specific milestone</suggest-task>
\`\`\`

## Current Iteration: ${state.iteration}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : " (unlimited)"}

Now, work on the current task. Good luck!
`.trim();
	}

	// Default mode
	return `
# Ralph Wiggum Loop - Iteration ${state.iteration}

You are in an iterative development loop. Work on the task below until you can genuinely complete it.
${contextSection}
## Your Task

${state.prompt}

## Instructions

1. Read the current state of files to understand what's been done
2. Track your progress and plan remaining work
3. Make progress on the task
4. Run tests/verification if applicable
5. When the task is GENUINELY COMPLETE, output:
   <promise>${state.completionPromise}</promise>

## Critical Rules

- ONLY output <promise>${state.completionPromise}</promise> when the task is truly done
- Do NOT lie or output false promises to exit the loop
- If stuck, try a different approach
- Check your work before claiming completion
- The loop will continue until you succeed

## Current Iteration: ${state.iteration}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : " (unlimited)"}

Now, work on the task. Good luck!
`.trim();
}

// ============================================================================
// Output streaming
// ============================================================================

function formatToolSummary(
	toolCounts: Map<string, number>,
	maxItems = 6,
): string {
	if (!toolCounts.size) return "";
	const entries = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1]);
	const shown = entries.slice(0, maxItems);
	const remaining = entries.length - shown.length;
	const parts = shown.map(([name, count]) => `${name} ${count}`);
	if (remaining > 0) parts.push(`+${remaining} more`);
	return parts.join(" • ");
}

async function streamProcessOutput(
	proc: ReturnType<typeof Bun.spawn>,
	options: {
		compactTools: boolean;
		toolSummaryIntervalMs: number;
		heartbeatIntervalMs: number;
		iterationStart: number;
		agent: AgentConfig;
		inactivityTimeoutMs: number;
		logLine?: (line: string) => void;
	},
): Promise<{
	stdoutText: string;
	stderrText: string;
	toolCounts: Map<string, number>;
	timedOut: boolean;
}> {
	const toolCounts = new Map<string, number>();
	let stdoutText = "";
	let stderrText = "";
	let lastPrintedAt = Date.now();
	let lastActivityAt = Date.now();
	let lastToolSummaryAt = 0;
	let timedOut = false;

	const log = (line: string) => {
		console.log(line);
		options.logLine?.(`${line}\n`);
	};

	const logErr = (line: string) => {
		console.error(line);
		options.logLine?.(`${line}\n`);
	};

	const maybePrintToolSummary = (force = false) => {
		if (!options.compactTools || toolCounts.size === 0) return;
		const now = Date.now();
		if (!force && now - lastToolSummaryAt < options.toolSummaryIntervalMs)
			return;
		const summary = formatToolSummary(toolCounts);
		if (summary) {
			log(`| Tools    ${summary}`);
			lastPrintedAt = Date.now();
			lastToolSummaryAt = Date.now();
		}
	};

	const handleLine = (line: string, isError: boolean) => {
		lastActivityAt = Date.now();
		const tool = options.agent.parseToolOutput(line);
		if (tool) {
			toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
			if (options.compactTools) {
				maybePrintToolSummary();
				return;
			}
		}
		if (line.length === 0) {
			log("");
			lastPrintedAt = Date.now();
			return;
		}
		if (isError) logErr(line);
		else log(line);
		lastPrintedAt = Date.now();
	};

	const streamText = async (
		stream: ReadableStream<Uint8Array> | null,
		onText: (chunk: string) => void,
		isError: boolean,
		shouldExit: () => boolean,
	) => {
		if (!stream) return;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		const readWithTimeout = async (): Promise<{
			value?: Uint8Array;
			done: boolean;
		} | null> => {
			// Check exit flag every 100ms while waiting for read
			const readPromise = reader.read();
			while (true) {
				const result = await Promise.race([
					readPromise,
					new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
				]);
				if (result !== null) return result;
				if (shouldExit()) {
					try {
						reader.cancel();
					} catch {}
					return { done: true };
				}
			}
		};

		while (true) {
			if (shouldExit()) {
				try {
					reader.cancel();
				} catch {}
				break;
			}
			const result = await readWithTimeout();
			if (!result || result.done) break;
			const text = decoder.decode(result.value, { stream: true });
			if (text.length > 0) {
				onText(text);
				buffer += text;
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() ?? "";
				for (const line of lines) handleLine(line, isError);
			}
		}
		const flushed = decoder.decode();
		if (flushed.length > 0) {
			onText(flushed);
			buffer += flushed;
		}
		if (buffer.length > 0) handleLine(buffer, isError);
	};

	let killAttempts = 0;
	let forceExit = false;

	const heartbeatTimer = setInterval(async () => {
		const now = Date.now();
		const inactivityDuration = now - lastActivityAt;

		if (
			options.inactivityTimeoutMs > 0 &&
			inactivityDuration >= options.inactivityTimeoutMs
		) {
			timedOut = true;
			killAttempts++;

			if (killAttempts === 1) {
				log(
					`\n⏰ INACTIVITY TIMEOUT: No output for ${formatDuration(inactivityDuration)}. Sending SIGTERM...`,
				);
				try {
					proc.kill("SIGTERM");
				} catch {}
			} else if (killAttempts === 2) {
				log(`⏰ Process didn't respond to SIGTERM. Sending SIGKILL...`);
				try {
					proc.kill("SIGKILL");
				} catch {}
			} else if (killAttempts === 3) {
				log(`⏰ Killing process tree (PID: ${proc.pid})...`);
				await killProcessTree(proc.pid);
			} else if (killAttempts >= 4) {
				// Force exit - the streams are stuck
				forceExit = true;
			}
			return;
		}

		if (now - lastPrintedAt >= options.heartbeatIntervalMs) {
			const elapsed = formatDuration(now - options.iterationStart);
			const sinceActivity = formatDuration(now - lastActivityAt);
			const timeoutIn =
				options.inactivityTimeoutMs > 0
					? ` · timeout in ${formatDuration(options.inactivityTimeoutMs - inactivityDuration)}`
					: "";
			log(
				`⏳ working... elapsed ${elapsed} · last activity ${sinceActivity} ago${timeoutIn}`,
			);
			lastPrintedAt = now;
		}
	}, options.heartbeatIntervalMs);

	try {
		await Promise.all([
			streamText(
				proc.stdout as ReadableStream<Uint8Array> | null,
				(chunk) => {
					stdoutText += chunk;
				},
				false,
				() => forceExit,
			),
			streamText(
				proc.stderr as ReadableStream<Uint8Array> | null,
				(chunk) => {
					stderrText += chunk;
				},
				true,
				() => forceExit,
			),
		]);
	} finally {
		clearInterval(heartbeatTimer);
	}

	// If we force-exited, make one more attempt to clean up
	if (forceExit) {
		log(`⏰ Force-exiting stream readers after timeout`);
		await killProcessTree(proc.pid);
	}

	if (options.compactTools) maybePrintToolSummary(true);

	return { stdoutText, stderrText, toolCounts, timedOut };
}

// ============================================================================
// File snapshot for change detection
// ============================================================================

interface FileSnapshot {
	files: Map<string, string>;
}

async function captureFileSnapshot(): Promise<FileSnapshot> {
	const files = new Map<string, string>();
	try {
		const status = await $`git status --porcelain`.text();
		const modifiedFiles: string[] = [];
		for (const line of status.split("\n")) {
			if (line.trim()) modifiedFiles.push(line.substring(3).trim());
		}
		for (const file of modifiedFiles) {
			try {
				const hash = await $`git hash-object ${file} 2>/dev/null`.text();
				files.set(file, hash.trim());
			} catch {}
		}
	} catch {}
	return { files };
}

function getModifiedFilesSinceSnapshot(
	before: FileSnapshot,
	after: FileSnapshot,
): string[] {
	const changedFiles: string[] = [];
	for (const [file, hash] of after.files) {
		if (before.files.get(file) !== hash) changedFiles.push(file);
	}
	for (const [file] of before.files) {
		if (!after.files.has(file)) changedFiles.push(file);
	}
	return changedFiles;
}

function extractErrors(output: string): string[] {
	const errors: string[] = [];
	const lines = output.split("\n");
	for (const line of lines) {
		const lower = line.toLowerCase();
		if (
			lower.includes("error:") ||
			lower.includes("failed:") ||
			lower.includes("exception:") ||
			lower.includes("typeerror") ||
			lower.includes("syntaxerror") ||
			lower.includes("referenceerror") ||
			(lower.includes("test") && lower.includes("fail"))
		) {
			const cleaned = line.trim().substring(0, 200);
			if (cleaned && !errors.includes(cleaned)) errors.push(cleaned);
		}
	}
	return errors.slice(0, 10);
}

// ============================================================================
// Command: status
// ============================================================================

function cmdStatus(flags: Record<string, string | boolean>): void {
	if (flags.workspace) workspaceRoot = flags.workspace as string;

	const state = loadState();
	const history = loadHistory();
	const context = loadContext();

	console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                  Chief Wiggum - Ralph Loop Status                ║
╚══════════════════════════════════════════════════════════════════╝
`);

	if (state?.active) {
		const elapsed = Date.now() - new Date(state.startedAt).getTime();
		console.log(`🔄 ACTIVE LOOP`);
		console.log(
			`   Iteration:    ${state.iteration}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : " (unlimited)"}`,
		);
		console.log(`   Started:      ${state.startedAt}`);
		console.log(`   Elapsed:      ${formatDurationLong(elapsed)}`);
		console.log(`   Promise:      ${state.completionPromise}`);
		const agentLabel = state.agent
			? (AGENTS[state.agent]?.configName ?? state.agent)
			: "OpenCode";
		console.log(`   Agent:        ${agentLabel}`);
		if (state.model) console.log(`   Model:        ${state.model}`);
		if (state.structuredTasksFile) {
			console.log(`   Tasks File:   ${state.structuredTasksFile}`);
			if (state.milestoneFilter)
				console.log(`   Milestone:    ${state.milestoneFilter}`);
		}
	} else {
		console.log(`⏹️  No active loop`);
	}

	if (context) {
		console.log(`\n📝 PENDING CONTEXT:`);
		console.log(`   ${context.split("\n").join("\n   ")}`);
	}

	if (history.iterations.length > 0) {
		console.log(`\n📊 HISTORY (${history.iterations.length} iterations)`);
		console.log(
			`   Total time: ${formatDurationLong(history.totalDurationMs)}`,
		);

		const recent = history.iterations.slice(-5);
		console.log(`\n   Recent:`);
		for (const iter of recent) {
			const tools = Object.entries(iter.toolsUsed)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([k, v]) => `${k}:${v}`)
				.join(" ");
			const status = iter.completionDetected
				? "✅"
				: iter.exitCode !== 0
					? "❌"
					: "🔄";
			console.log(
				`   ${status} #${iter.iteration}: ${formatDurationLong(iter.durationMs)} | ${tools || "no tools"}`,
			);
		}
	}

	console.log("");
}

// ============================================================================
// Command: context
// ============================================================================

function cmdContext(
	args: string[],
	flags: Record<string, string | boolean>,
): void {
	if (flags.workspace) workspaceRoot = flags.workspace as string;

	if (flags.clear) {
		if (existsSync(getContextPath())) {
			unlinkSync(getContextPath());
			console.log(`✅ Context cleared`);
		} else {
			console.log(`ℹ️  No pending context to clear`);
		}
		return;
	}

	const contextText = args.join(" ");
	if (!contextText) {
		console.error("Error: No context text provided");
		console.error("Usage: chief-wiggum context <text>");
		console.error("       chief-wiggum context --clear");
		process.exit(1);
	}

	const stateDir = getStateDir();
	if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

	const timestamp = new Date().toISOString();
	const newEntry = `\n## Context added at ${timestamp}\n${contextText}\n`;

	const contextPath = getContextPath();
	if (existsSync(contextPath)) {
		const existing = readFileSync(contextPath, "utf-8");
		writeFileSync(contextPath, existing + newEntry);
	} else {
		writeFileSync(contextPath, `# Ralph Loop Context\n${newEntry}`);
	}

	console.log(`✅ Context added for next iteration`);

	const state = loadState();
	if (state?.active) {
		console.log(`   Will be picked up in iteration ${state.iteration + 1}`);
	}
}

// ============================================================================
// Command: tasks
// ============================================================================

function cmdTasks(
	args: string[],
	flags: Record<string, string | boolean>,
): void {
	if (flags.workspace) workspaceRoot = flags.workspace as string;
	if (flags.tasksFile) structuredTasksFile = flags.tasksFile as string;

	const subcommand = args[0] || "list";

	if (subcommand === "add") {
		const desc = args.slice(1).join(" ");
		if (!desc) {
			console.error("Error: No task description");
			console.error("Usage: chief-wiggum tasks add <description>");
			process.exit(1);
		}

		const tasksPath = getTasksPath();
		const stateDir = getStateDir();
		if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

		let content = "";
		if (existsSync(tasksPath)) {
			content = readFileSync(tasksPath, "utf-8");
		} else {
			content = "# Ralph Tasks\n\n";
		}

		writeFileSync(tasksPath, `${content.trimEnd()}\n- [ ] ${desc}\n`);
		console.log(`✅ Task added: "${desc}"`);
		return;
	}

	if (subcommand === "rm") {
		const indexStr = args[1];
		if (!indexStr || Number.isNaN(parseInt(indexStr, 10))) {
			console.error("Error: Invalid task index");
			console.error("Usage: chief-wiggum tasks rm <index>");
			process.exit(1);
		}

		const taskIndex = parseInt(indexStr, 10);
		const tasksPath = getTasksPath();

		if (!existsSync(tasksPath)) {
			console.error("Error: No tasks file found");
			process.exit(1);
		}

		const content = readFileSync(tasksPath, "utf-8");
		const tasks = parseTasks(content);

		if (taskIndex < 1 || taskIndex > tasks.length) {
			console.error(
				`Error: Index ${taskIndex} out of range (1-${tasks.length})`,
			);
			process.exit(1);
		}

		const lines = content.split("\n");
		const newLines: string[] = [];
		let inRemovedTask = false;
		let currentTaskLine = 0;

		for (const line of lines) {
			if (line.match(/^- \[/)) {
				currentTaskLine++;
				if (currentTaskLine === taskIndex) {
					inRemovedTask = true;
					continue;
				} else {
					inRemovedTask = false;
				}
			}
			if (inRemovedTask && line.match(/^\s+/) && line.trim() !== "") continue;
			newLines.push(line);
		}

		writeFileSync(tasksPath, newLines.join("\n"));
		console.log(`✅ Removed task ${taskIndex}`);
		return;
	}

	// Default: list tasks
	// Try structured tasks first, then simple tasks
	if (structuredTasksFile) {
		const data = loadStructuredTasks();
		if (data) {
			console.log("Structured Tasks:\n");
			for (const [milestone, tasks] of data.milestones) {
				const complete = tasks.filter((t) => t.status === "complete").length;
				console.log(`## ${milestone} (${complete}/${tasks.length})`);
				for (const task of tasks) {
					const icon =
						task.status === "complete"
							? "✅"
							: task.status === "in-progress"
								? "🔄"
								: "⏸️";
					console.log(`   ${icon} ${task.id}: ${task.title}`);
				}
				console.log("");
			}
			return;
		}
	}

	const tasksPath = getTasksPath();
	if (!existsSync(tasksPath)) {
		console.log("No tasks file found.");
		console.log("Use 'chief-wiggum tasks add <description>' to create tasks.");
		return;
	}

	const content = readFileSync(tasksPath, "utf-8");
	const tasks = parseTasks(content);

	if (tasks.length === 0) {
		console.log("No tasks found.");
		return;
	}

	console.log("Tasks:\n");
	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i];
		const icon =
			task.status === "complete"
				? "✅"
				: task.status === "in-progress"
					? "🔄"
					: "⏸️";
		console.log(`${i + 1}. ${icon} ${task.text}`);
		for (const sub of task.subtasks) {
			const subIcon =
				sub.status === "complete"
					? "✅"
					: sub.status === "in-progress"
						? "🔄"
						: "⏸️";
			console.log(`      ${subIcon} ${sub.text}`);
		}
	}
}

// ============================================================================
// Command: assist
// ============================================================================

async function cmdAssist(
	flags: Record<string, string | boolean>,
): Promise<void> {
	if (flags.workspace) workspaceRoot = flags.workspace as string;
	if (flags.tasksFile) structuredTasksFile = flags.tasksFile as string;

	// Default tasks file if not set
	if (!structuredTasksFile) {
		const state = loadState();
		if (state?.structuredTasksFile) {
			structuredTasksFile = state.structuredTasksFile;
		} else {
			structuredTasksFile = "docs/tasks.md";
		}
	}

	// Load milestone filter from state if available
	const state = loadState();
	if (state?.milestoneFilter) {
		milestoneFilter = state.milestoneFilter;
	}

	// Build and write context file
	const contextContent = buildAssistContext();
	const stateDir = getStateDir();
	if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

	const contextPath = getAssistContextPath();
	writeFileSync(contextPath, contextContent);

	console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                  Chief Wiggum - Assist Mode                      ║
╚══════════════════════════════════════════════════════════════════╝

📄 Context written to: ${contextPath}

Opening opencode...

To use the context, reference the file in your conversation:
  "Read .ralph/assist-context.md for context about the loop"

`);

	// Check if opencode is available
	const opencodePath = Bun.which("opencode");
	if (!opencodePath) {
		console.error("Error: opencode CLI not found in PATH");
		console.log("Install opencode or ensure it's in your PATH");
		process.exit(1);
	}

	// Spawn opencode TUI
	const proc = Bun.spawn(["opencode"], {
		cwd: workspaceRoot,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});

	await proc.exited;
}

// ============================================================================
// HTTP Server helpers
// ============================================================================

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			...CORS_HEADERS,
		},
	});
}

function logRequest(method: string, path: string, status: number): void {
	const timestamp = new Date().toISOString();
	console.log(`[${timestamp}] ${method} ${path} → ${status}`);
}

function startHttpServer(port: number): ReturnType<typeof Bun.serve> {
	const serverStartedAt = Date.now();
	const server = Bun.serve<WSData>({
		port,
		fetch(req, server) {
			const url = new URL(req.url);
			const path = url.pathname;
			const method = req.method;

			// Handle WebSocket upgrade for /events endpoint
			if (path === "/events") {
				const clientId = wsManager.generateClientId();
				const upgraded = server.upgrade(req, {
					data: { id: clientId },
				});
				if (upgraded) {
					return undefined;
				}
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (method === "OPTIONS") {
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			}

			let response: Response;

			try {
				if (method === "GET" && path === "/status") {
					const state = loadState();
					const history = loadHistory();
					const context = loadContext();
					response = jsonResponse({
						active: state?.active ?? false,
						state: state ?? null,
						history: history ?? null,
						context: context ?? null,
					});
				} else if (method === "GET" && path === "/health") {
					response = jsonResponse({
						status: "healthy",
						version: VERSION,
						uptime: Date.now() - serverStartedAt,
					});
				} else if (method === "GET" && path === "/tasks") {
					if (structuredTasksFile) {
						const data = loadStructuredTasks();
						if (data) {
							const allTasks = Array.from(data.allTasks.values());
							const complete = allTasks.filter(
								(t) => t.status === "complete",
							).length;
							const inProgress = allTasks.filter(
								(t) => t.status === "in-progress",
							).length;
							const todo = allTasks.filter((t) => t.status === "todo").length;
							const failed = allTasks.filter(
								(t) => t.status === "failed",
							).length;
							response = jsonResponse({
								total: allTasks.length,
								complete,
								inProgress,
								todo,
								failed,
								tasks: allTasks,
							});
						} else {
							response = jsonResponse({
								total: 0,
								complete: 0,
								inProgress: 0,
								todo: 0,
								failed: 0,
								tasks: [],
							});
						}
					} else {
						response = jsonResponse({
							total: 0,
							complete: 0,
							inProgress: 0,
							todo: 0,
							failed: 0,
							tasks: [],
						});
					}
				} else if (method === "POST" && path === "/context") {
					return (async () => {
						try {
							const body = await req.json();
							const text = body.text as string;

							if (!text) {
								return jsonResponse(
									{ success: false, error: "Missing 'text' field" },
									400,
								);
							}

							const stateDir = getStateDir();
							if (!existsSync(stateDir))
								mkdirSync(stateDir, { recursive: true });

							const timestamp = new Date().toISOString();
							const newEntry = `\n## Context added at ${timestamp}\n${text}\n`;

							const contextPath = getContextPath();
							if (existsSync(contextPath)) {
								const existing = readFileSync(contextPath, "utf-8");
								writeFileSync(contextPath, existing + newEntry);
							} else {
								writeFileSync(contextPath, `# Ralph Loop Context\n${newEntry}`);
							}

							// Broadcast context.received event
							wsManager.broadcast({
								type: "context.received",
								text,
							});

							console.log(
								`\n📝 CONTEXT INJECTED: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`,
							);

							return jsonResponse({ success: true, action: "added" });
						} catch {
							return jsonResponse(
								{ success: false, error: "Invalid JSON body" },
								400,
							);
						}
					})();
				} else if (method === "GET" && path === "/summary") {
					// Returns analyzed summary of ALL log files in logs/ (not archived)
					const logDir = getLogDir();
					const includeRaw = url.searchParams.get("raw") === "true";

					if (!existsSync(logDir)) {
						response = jsonResponse({
							error: "No log directory found",
							logDir,
							files: [],
						});
					} else {
						const logFiles = readdirSync(logDir)
							.filter((f) => f.endsWith(".log"))
							.sort(); // oldest first for concatenation

						if (logFiles.length === 0) {
							response = jsonResponse({
								error: "No log files found. Start a loop with logging enabled.",
								logDir,
								files: [],
							});
						} else {
							// Concatenate all log files
							let combinedContent = "";
							for (const file of logFiles) {
								const content = readFileSync(join(logDir, file), "utf-8");
								combinedContent += `${content}\n`;
							}

							// Analyze the logs
							const analysis = analyzeLogContent(combinedContent);

							response = jsonResponse({
								files: logFiles,
								fileCount: logFiles.length,
								analysis,
								...(includeRaw ? { rawContent: combinedContent } : {}),
							});
						}
					}
				} else if (method === "GET" && path === "/logs/raw") {
					// Returns raw concatenated content of ALL current log files (for LLM analysis)
					const logDir = getLogDir();

					if (!existsSync(logDir)) {
						response = jsonResponse({
							error: "No log directory found",
							files: [],
							fileCount: 0,
							content: "",
							totalBytes: 0,
						});
					} else {
						const logFiles = readdirSync(logDir)
							.filter((f) => f.endsWith(".log"))
							.sort();

						if (logFiles.length === 0) {
							response = jsonResponse({
								files: [],
								fileCount: 0,
								content: "",
								totalBytes: 0,
							});
						} else {
							let combinedContent = "";
							for (const file of logFiles) {
								const content = readFileSync(join(logDir, file), "utf-8");
								combinedContent += `\n=== ${file} ===\n${content}`;
							}

							// Include config file paths from state
							const state = loadState();
							response = jsonResponse({
								files: logFiles,
								fileCount: logFiles.length,
								content: combinedContent,
								totalBytes: combinedContent.length,
								configFiles: {
									promptFile: state?.promptFile || null,
									tasksFile: state?.structuredTasksFile || null,
								},
							});
						}
					}
				} else if (method === "GET" && path === "/logs") {
					// Returns archived log files from logs/archive/
					const logDir = getLogDir();
					const archiveDir = join(logDir, "archive");
					const requestedFile = url.searchParams.get("file");

					if (!existsSync(archiveDir)) {
						response = jsonResponse({
							archiveDir,
							archivedFiles: [],
							count: 0,
							message:
								"No archived logs. Use POST /logs/archive to archive current logs.",
						});
					} else {
						const archivedFiles = readdirSync(archiveDir)
							.filter((f) => f.endsWith(".log"))
							.sort()
							.reverse();

						if (!requestedFile) {
							// List available archived log files
							response = jsonResponse({
								archiveDir,
								archivedFiles,
								count: archivedFiles.length,
							});
						} else {
							// Read specific archived log file
							const logPath = join(archiveDir, requestedFile);

							if (!existsSync(logPath)) {
								response = jsonResponse(
									{ error: `Archived log not found: ${requestedFile}` },
									404,
								);
							} else {
								const content = readFileSync(logPath, "utf-8");

								response = jsonResponse({
									file: requestedFile,
									path: logPath,
									content,
								});
							}
						}
					}
				} else if (method === "POST" && path === "/logs/archive") {
					// Move all current logs to archive folder
					const logDir = getLogDir();
					const archiveDir = join(logDir, "archive");

					if (!existsSync(logDir)) {
						response = jsonResponse({ error: "No log directory found" }, 404);
					} else {
						const logFiles = readdirSync(logDir).filter((f) =>
							f.endsWith(".log"),
						);

						if (logFiles.length === 0) {
							response = jsonResponse({
								archived: [],
								count: 0,
								message: "No log files to archive",
							});
						} else {
							// Create archive directory if needed
							if (!existsSync(archiveDir)) {
								mkdirSync(archiveDir, { recursive: true });
							}

							const archived: string[] = [];
							const skipped: string[] = [];

							for (const file of logFiles) {
								const srcPath = join(logDir, file);
								const destPath = join(archiveDir, file);

								// Skip the currently active log file
								if (srcPath === logFilePath) {
									skipped.push(file);
									continue;
								}

								try {
									copyFileSync(srcPath, destPath);
									unlinkSync(srcPath);
									archived.push(file);
								} catch (_err) {
									skipped.push(file);
								}
							}

							response = jsonResponse({
								archived,
								skipped,
								archivedCount: archived.length,
								skippedCount: skipped.length,
								archiveDir,
							});
						}
					}
				} else if (method === "POST" && path === "/task/mark") {
					return (async () => {
						try {
							const body = await req.json();
							const taskId = body.taskId as string;
							const status = body.status as string;
							const reason = body.reason as string | undefined;

							if (!taskId || !status) {
								return jsonResponse(
									{ success: false, error: "Missing 'taskId' or 'status'" },
									400,
								);
							}

							const validStatuses = [
								"todo",
								"in-progress",
								"complete",
								"failed",
							];
							if (!validStatuses.includes(status)) {
								return jsonResponse(
									{
										success: false,
										error: `Invalid status: ${status}. Valid: ${validStatuses.join(", ")}`,
									},
									400,
								);
							}

							if (!structuredTasksFile) {
								return jsonResponse(
									{
										success: false,
										error: "No structured tasks file configured",
									},
									400,
								);
							}

							const filePath = join(workspaceRoot, structuredTasksFile);
							if (!existsSync(filePath)) {
								return jsonResponse(
									{
										success: false,
										error: `Tasks file not found: ${structuredTasksFile}`,
									},
									404,
								);
							}

							const content = readFileSync(filePath, "utf-8");
							const lines = content.split("\n");
							const statusCharMap: Record<string, string> = {
								todo: " ",
								"in-progress": "/",
								complete: "x",
								failed: "!",
							};
							const newChar = statusCharMap[status];

							let found = false;
							let taskLineIndex = -1;
							for (let i = 0; i < lines.length; i++) {
								const match = lines[i].match(
									/^(-\s+\[)([ x/!])(\]\s+)([a-zA-Z0-9_-]+)(:\s*.+)$/,
								);
								if (match && match[4] === taskId) {
									lines[i] =
										`${match[1]}${newChar}${match[3]}${match[4]}${match[5]}`;
									taskLineIndex = i;
									found = true;
									break;
								}
							}

							if (!found) {
								return jsonResponse(
									{ success: false, error: `Task not found: ${taskId}` },
									404,
								);
							}

							const now = new Date().toISOString();
							let insertIndex = taskLineIndex + 1;
							while (
								insertIndex < lines.length &&
								lines[insertIndex].match(/^\s+-\s+\w+:/)
							) {
								insertIndex++;
							}

							const metaLines: string[] = [];
							if (status === "in-progress") {
								metaLines.push(`  - started: ${now}`);
							} else if (status === "complete") {
								metaLines.push(`  - completed: ${now}`);
							} else if (status === "failed") {
								metaLines.push(`  - failed: ${reason || "Marked as failed"}`);
							}

							if (metaLines.length > 0) {
								lines.splice(insertIndex, 0, ...metaLines);
							}

							writeFileSync(filePath, lines.join("\n"));

							console.log(
								`📋 Task ${taskId} marked as ${status}${reason ? ` (${reason})` : ""}`,
							);

							return jsonResponse({
								success: true,
								taskId,
								status,
								reason: reason || null,
								updatedAt: now,
							});
						} catch {
							return jsonResponse(
								{ success: false, error: "Invalid JSON body" },
								400,
							);
						}
					})();
				} else if (method === "GET" && path === "/suggested-tasks") {
					const suggestedPath = getSuggestedTasksPath();
					try {
						const content = readFileSync(suggestedPath, "utf-8");
						response = jsonResponse({ path: suggestedPath, content });
					} catch {
						response = jsonResponse({
							path: suggestedPath,
							content: null,
							message:
								"No suggested tasks file found. Tasks are suggested via <suggest-task> tags during iterations.",
						});
					}
				} else if (method === "POST" && path === "/stop") {
					const state = loadState();
					if (state?.active) {
						state.active = false;
						saveState(state);
						wsManager.broadcast({
							type: "loop.stopped",
							reason: "Stopped via HTTP",
							loopId: state.loopId || "",
							iteration: state.iteration,
						});
						console.log(`\n🛑 LOOP STOP REQUESTED via HTTP`);
						response = jsonResponse({
							success: true,
							stoppedAt: new Date().toISOString(),
							iteration: state.iteration,
						});
					} else {
						response = jsonResponse(
							{ success: false, error: "No active loop" },
							400,
						);
					}
				} else if (method === "POST" && path === "/start") {
					return (async () => {
						try {
							const body = await req.json();
							const promptFile = body.promptFile as string | undefined;
							const promptText = body.prompt as string | undefined;
							const tasksFile = body.tasksFile as string | undefined;
							const milestone = body.milestone as string | undefined;

							let prompt = promptText || "";
							if (promptFile) {
								const fullPath = join(workspaceRoot, promptFile);
								if (existsSync(fullPath)) {
									prompt = readFileSync(fullPath, "utf-8");
								} else {
									return jsonResponse(
										{
											success: false,
											error: `Prompt file not found: ${promptFile}`,
										},
										404,
									);
								}
							}

							if (!prompt) {
								return jsonResponse(
									{ success: false, error: "No prompt provided" },
									400,
								);
							}

							if (tasksFile) {
								structuredTasksFile = tasksFile;
							}
							if (milestone) {
								milestoneFilter = milestone;
							}

							const loopId = `loop-${Date.now()}`;
							const state: RalphState = {
								active: true,
								iteration: 1,
								maxIterations: 0,
								completionPromise: "COMPLETE",
								tasksMode: !!tasksFile,
								taskPromise: "READY_FOR_NEXT_TASK",
								prompt,
								promptFile: promptFile || null,
								startedAt: new Date().toISOString(),
								model: "anthropic/claude-opus-4-5",
								agent: "opencode",
								workspaceRoot,
								structuredTasksFile,
								milestoneFilter,
								loopId,
							};
							saveState(state);

							const history: RalphHistory = {
								iterations: [],
								totalDurationMs: 0,
								struggleIndicators: {
									repeatedErrors: {},
									noProgressIterations: 0,
									shortIterations: 0,
								},
							};
							saveHistory(history);

							const builtPrompt = buildPrompt(state, AGENTS.opencode);
							const nextTask = getNextStructuredTask(milestoneFilter);

							wsManager.broadcast({
								type: "loop.started",
								loopId,
								prompt: builtPrompt,
								task: nextTask || undefined,
							});

							console.log(`\n\u{1F680} Loop started via HTTP (${loopId})`);

							return jsonResponse({
								success: true,
								loopId,
								prompt: builtPrompt,
								task: nextTask
									? {
											id: nextTask.id,
											title: nextTask.title,
											status: nextTask.status,
										}
									: undefined,
								iteration: 1,
							});
						} catch {
							return jsonResponse(
								{ success: false, error: "Invalid JSON body" },
								400,
							);
						}
					})();
				} else if (method === "POST" && path === "/iteration/complete") {
					return (async () => {
						try {
							const body = await req.json();
							const filesModified = (body.filesModified as string[]) || [];
							const errors = (body.errors as string[]) || [];
							const _notes = body.notes as string | undefined;
							const completionDetected = !!body.completionDetected;

							const state = loadState();
							if (!state?.active) {
								return jsonResponse(
									{ success: false, error: "No active loop" },
									400,
								);
							}

							const history = loadHistory();
							const now = new Date();
							const iterStart =
								history.iterations.length > 0
									? history.iterations[history.iterations.length - 1].endedAt
									: state.startedAt;
							const durationMs = now.getTime() - new Date(iterStart).getTime();

							history.iterations.push({
								iteration: state.iteration,
								startedAt: iterStart,
								endedAt: now.toISOString(),
								durationMs,
								toolsUsed: {},
								filesModified,
								exitCode: 0,
								completionDetected,
								errors,
							});
							history.totalDurationMs += durationMs;

							const madeProgress =
								filesModified.length > 0 || completionDetected;
							if (!madeProgress)
								history.struggleIndicators.noProgressIterations++;
							else history.struggleIndicators.noProgressIterations = 0;

							if (durationMs < 30000)
								history.struggleIndicators.shortIterations++;
							else history.struggleIndicators.shortIterations = 0;

							if (errors.length === 0)
								history.struggleIndicators.repeatedErrors = {};
							else {
								for (const error of errors) {
									const key = error.substring(0, 100);
									history.struggleIndicators.repeatedErrors[key] =
										(history.struggleIndicators.repeatedErrors[key] || 0) + 1;
								}
							}
							saveHistory(history);

							wsManager.broadcast({
								type: "iteration.completed",
								iteration: state.iteration,
								result: history.iterations[history.iterations.length - 1],
							});

							if (!state.active) {
								return jsonResponse({
									success: true,
									next: "stop",
									iteration: state.iteration,
								});
							}

							if (
								state.tasksMode &&
								allStructuredTasksComplete(milestoneFilter)
							) {
								clearState();
								clearHistory();
								clearContext();
								wsManager.broadcast({
									type: "loop.completed",
									history,
									loopId: state.loopId || "",
								});
								return jsonResponse({
									success: true,
									next: "complete",
									iteration: state.iteration,
								});
							}

							state.iteration++;
							saveState(state);

							const builtPrompt = buildPrompt(state, AGENTS.opencode);
							const nextTask = getNextStructuredTask(milestoneFilter);

							return jsonResponse({
								success: true,
								next: "continue",
								iteration: state.iteration,
								task: nextTask
									? {
											id: nextTask.id,
											title: nextTask.title,
											status: nextTask.status,
										}
									: undefined,
								prompt: builtPrompt,
							});
						} catch {
							return jsonResponse(
								{ success: false, error: "Invalid JSON body" },
								400,
							);
						}
					})();
				} else if (method === "GET" && path === "/next-task") {
					if (!structuredTasksFile) {
						response = jsonResponse({
							hasTask: false,
							complete: false,
							reason: "No tasks file configured",
						});
					} else if (allStructuredTasksComplete(milestoneFilter)) {
						response = jsonResponse({
							hasTask: false,
							complete: true,
							reason: "All tasks are complete",
						});
					} else {
						const task = getNextStructuredTask(milestoneFilter);
						if (task) {
							response = jsonResponse({
								hasTask: true,
								complete: false,
								task: {
									id: task.id,
									title: task.title,
									milestone: task.milestone,
									status: task.status,
									depends: task.depends,
									verify: task.verify,
								},
							});
						} else {
							const failure = isMilestoneFailed(milestoneFilter);
							response = jsonResponse({
								hasTask: false,
								complete: false,
								reason: failure.failed
									? "Remaining tasks are blocked by failed dependencies"
									: "No available tasks",
							});
						}
					}
				} else if (method === "GET" && path === "/context") {
					const ctx = loadContext();
					if (ctx) {
						clearContext();
						response = jsonResponse({
							hasContext: true,
							context: ctx,
							clearedAt: new Date().toISOString(),
						});
					} else {
						response = jsonResponse({ hasContext: false, context: null });
					}
				} else if (method === "GET" && path === "/history") {
					response = jsonResponse(loadHistory());
				} else {
					response = jsonResponse({ error: "Not found" }, 404);
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Internal server error";
				response = jsonResponse({ error: message }, 500);
			}

			logRequest(method, path, response.status);
			return response;
		},
		websocket: {
			open(ws) {
				wsManager.addClient(ws);
			},
			message(ws, message) {
				console.log(`[WS] Received message from ${ws.data.id}: ${message}`);
			},
			close(ws) {
				wsManager.removeClient(ws);
			},
		},
	});

	return server;
}

// ============================================================================
// Command: serve
// ============================================================================

async function cmdServe(
	flags: Record<string, string | boolean>,
): Promise<void> {
	if (flags.workspace) workspaceRoot = flags.workspace as string;
	if (flags.tasksFile) structuredTasksFile = flags.tasksFile as string;
	if (flags.milestone) milestoneFilter = flags.milestone as string;

	if (!structuredTasksFile) {
		const defaultTasksFile = "docs/tasks.md";
		if (existsSync(defaultTasksFile)) {
			structuredTasksFile = defaultTasksFile;
		}
	}

	const port = parseInt((flags.port as string) || "3456", 10);
	if (flags.force) {
		try {
			const result = Bun.spawnSync(["lsof", "-ti", `:${port}`]);
			const pids = new TextDecoder()
				.decode(result.stdout)
				.trim()
				.split("\n")
				.filter(Boolean);
			for (const pid of pids) {
				process.kill(parseInt(pid, 10), "SIGKILL");
			}
			if (pids.length > 0) {
				console.log(
					`\u26A0\uFE0F  Killed ${pids.length} process(es) on port ${port}`,
				);
			}
		} catch {}
	}

	startHttpServer(port);

	console.log(`
\u2554${"\u2550".repeat(66)}\u2557
\u2551                  Chief Wiggum - Server Mode                       \u2551
\u255A${"\u2550".repeat(66)}\u255D
`);
	console.log(`\u{1F310} HTTP server running on http://localhost:${port}`);
	console.log("");
	console.log("Endpoints:");
	console.log("  POST /start              - Start a loop");
	console.log("  POST /iteration/complete - Complete an iteration");
	console.log("  GET  /next-task          - Get next available task");
	console.log("  GET  /context            - Get and clear pending context");
	console.log("  POST /context            - Inject context");
	console.log("  POST /task/mark          - Update task status");
	console.log("  GET  /status             - Loop status");
	console.log("  GET  /history            - Iteration history");
	console.log("  GET  /health             - Health check");
	console.log("  POST /stop               - Stop the loop");
	console.log("  WS   /events             - WebSocket events");
	console.log("");
	console.log("Waiting for connections... (Ctrl+C to stop)");
	console.log("\u2550".repeat(68));

	await new Promise(() => {});
}

// ============================================================================
// Code Review
// ============================================================================

async function runCodeReview(
	workspaceDir: string,
	timeoutMs: number,
): Promise<string | null> {
	try {
		const ahead = await $`git rev-list main..HEAD --count`
			.cwd(workspaceDir)
			.text();
		if (parseInt(ahead.trim(), 10) === 0) return null;
	} catch {
		return null;
	}

	const claudePath = Bun.which("claude");
	if (!claudePath) return null;

	let diff: string;
	try {
		diff = await $`git diff main...HEAD`.cwd(workspaceDir).text();
		if (!diff.trim()) return null;
	} catch {
		return null;
	}

	let reviewInstructions = "";
	try {
		const agentFile = join(
			workspaceDir,
			".opencode",
			"agents",
			"code-reviewer.md",
		);
		if (existsSync(agentFile)) {
			const raw = readFileSync(agentFile, "utf-8");
			reviewInstructions = raw.replace(/^---[\s\S]*?---\n*/, "");
		}
	} catch {}

	if (!reviewInstructions) {
		reviewInstructions =
			"Review the diff for bloat, low-value tests, and unnecessary custom components.";
	}

	const prompt = `${reviewInstructions}\n\n## Diff\n\n\`\`\`diff\n${diff}\n\`\`\``;

	console.log("\u{1F50D} Running code review...");

	const reviewTimeout = Math.min(timeoutMs, 5 * 60 * 1000);

	try {
		const proc = Bun.spawn(
			["claude", "-p", prompt, "--model", "claude-opus-4-5-20250514"],
			{
				cwd: workspaceDir,
				env: { ...process.env },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			},
		);

		const timeoutHandle = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, reviewTimeout);

		const output = await new Response(
			proc.stdout as ReadableStream<Uint8Array>,
		).text();
		await proc.exited;
		clearTimeout(timeoutHandle);

		return output;
	} catch {
		console.log("\u26A0\uFE0F  Code review skipped (claude unavailable)");
		return null;
	}
}

// ============================================================================
// Command: run
// ============================================================================

async function cmdRun(
	args: string[],
	flags: Record<string, string | boolean>,
): Promise<void> {
	// Build options from flags
	const opts: RunOptions = {
		prompt: "",
		promptFile: (flags.prompt as string) || "",
		model: (flags.model as string) || "anthropic/claude-opus-4-5",
		agent: ((flags.agent as string) || "opencode") as AgentType,
		iterations: parseInt((flags.iterations as string) || "0", 10) || 0,
		tasksFile: (flags.tasksFile as string) || null,
		milestone: (flags.milestone as string) || null,
		workspace: (flags.workspace as string) || process.cwd(),
		repo: (flags.repo as string) || null,
		branch: (flags.branch as string) || null,
		done: (flags.done as string) || "COMPLETE",
		next: (flags.next as string) || "READY_FOR_NEXT_TASK",
		timeout: parseInt((flags.timeout as string) || "30", 10) || 30,
		force: !!flags.force,
		verbose: !!flags.verbose,
		quiet: !!flags.quiet,
		noCommit: !!flags.noCommit,
		interactive: !!flags.interactive,
		noPlugins: !!flags.noPlugins,
		log: !flags.noLog,
	};

	// Set globals
	workspaceRoot = opts.workspace;
	structuredTasksFile = opts.tasksFile;
	milestoneFilter = opts.milestone;

	// Load prompt
	if (opts.promptFile) {
		if (!existsSync(opts.promptFile)) {
			console.error(`Error: Prompt file not found: ${opts.promptFile}`);
			process.exit(1);
		}
		opts.prompt = readFileSync(opts.promptFile, "utf-8");
	} else if (args.length > 0) {
		// Check if first arg is a file
		if (args.length === 1 && existsSync(args[0])) {
			opts.promptFile = args[0];
			opts.prompt = readFileSync(args[0], "utf-8");
		} else {
			opts.prompt = args.join(" ");
		}
	} else {
		// Try default prompt file
		const defaultPromptFile = "docs/prompt.md";
		if (existsSync(defaultPromptFile)) {
			opts.promptFile = defaultPromptFile;
			opts.prompt = readFileSync(defaultPromptFile, "utf-8");
		}
	}

	// Try default tasks file if not specified
	if (!opts.tasksFile) {
		const defaultTasksFile = "docs/tasks.md";
		if (existsSync(defaultTasksFile)) {
			opts.tasksFile = defaultTasksFile;
			structuredTasksFile = defaultTasksFile;
		}
	}

	if (!opts.prompt) {
		console.error("Error: No prompt provided");
		console.error("Usage: chief-wiggum run -f <file> [options]");
		console.error("       chief-wiggum run <prompt> [options]");
		console.error("");
		console.error("Or create docs/prompt.md and docs/tasks.md for defaults");
		process.exit(1);
	}

	// Handle worktree setup
	if (opts.repo) {
		if (!opts.promptFile) {
			console.error("Error: --repo requires -f <prompt-file>");
			process.exit(1);
		}
		const result = await setupWorktree(
			opts.repo,
			opts.prompt,
			opts.branch,
			opts.promptFile,
			opts.tasksFile,
		);
		workspaceRoot = result.worktreePath;
		opts.workspace = result.worktreePath;
		if (result.tasksFile) structuredTasksFile = result.tasksFile;

		const newPromptPath = join(workspaceRoot, result.promptFile);
		if (existsSync(newPromptPath)) {
			opts.prompt = readFileSync(newPromptPath, "utf-8");
		}
	}

	// Validate agent
	const agentConfig = AGENTS[opts.agent];
	if (!agentConfig) {
		console.error(`Error: Unknown agent: ${opts.agent}`);
		console.error("Available: opencode, claude-code, codex");
		process.exit(1);
	}

	const agentPath = Bun.which(agentConfig.command);
	if (!agentPath) {
		console.error(
			`Error: ${agentConfig.configName} CLI ('${agentConfig.command}') not found`,
		);
		process.exit(1);
	}

	// Check for existing state
	const existingState = loadState();
	if (existingState?.active) {
		if (opts.force) {
			console.log(
				`⚠️  Clearing stale state from iteration ${existingState.iteration}`,
			);
			clearState();
		} else {
			console.error(
				`Error: Loop already active (iteration ${existingState.iteration})`,
			);
			console.error(`Started: ${existingState.startedAt}`);
			console.error(`Use --force to clear and restart`);
			process.exit(1);
		}
	}

	// Initialize logging
	if (opts.log) {
		logFilePath = "auto";
		initLogFile();
	}

	// Print banner
	console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                  Chief Wiggum - Ralph Loop                      ║
║         Iterative AI Development with ${agentConfig.configName.padEnd(20)}        ║
╚══════════════════════════════════════════════════════════════════╝
`);

	const promptPreview =
		opts.prompt.replace(/\s+/g, " ").substring(0, 60) +
		(opts.prompt.length > 60 ? "..." : "");
	console.log(`Prompt:     ${promptPreview}`);
	console.log(`Agent:      ${agentConfig.configName}`);
	console.log(`Model:      ${opts.model}`);
	console.log(
		`Iterations: ${opts.iterations > 0 ? opts.iterations : "unlimited"}`,
	);
	console.log(
		`Timeout:    ${opts.timeout > 0 ? `${opts.timeout} minutes` : "disabled"}`,
	);
	if (opts.tasksFile) {
		console.log(`Tasks:      ${opts.tasksFile}`);
		if (opts.milestone) console.log(`Milestone:  ${opts.milestone}`);
		const summary = getStructuredTasksSummary(opts.milestone);
		console.log(`Progress:   ${summary.completed}/${summary.total} complete`);
	}
	console.log("");

	// Start HTTP server for external access
	const port = parseInt((flags.port as string) || "3456", 10);
	if (opts.force) {
		try {
			const result = Bun.spawnSync(["lsof", "-ti", `:${port}`]);
			const pids = new TextDecoder()
				.decode(result.stdout)
				.trim()
				.split("\n")
				.filter(Boolean);
			for (const pid of pids) {
				process.kill(parseInt(pid, 10), "SIGKILL");
			}
			if (pids.length > 0) {
				console.log(`⚠️  Killed ${pids.length} process(es) on port ${port}`);
			}
		} catch {}
	}
	startHttpServer(port);
	console.log(`🌐 HTTP server running on http://localhost:${port}`);
	console.log("   POST /context - inject context");
	console.log("   POST /stop    - stop the loop");
	console.log("   GET  /status  - check status");
	console.log("");
	console.log("Starting loop... (Ctrl+C to stop)");
	console.log("═".repeat(68));

	// Initialize state
	const state: RalphState = {
		active: true,
		iteration: 1,
		maxIterations: opts.iterations,
		completionPromise: opts.done,
		tasksMode: !!opts.tasksFile,
		taskPromise: opts.next,
		prompt: opts.prompt,
		promptFile: opts.promptFile || null,
		startedAt: new Date().toISOString(),
		model: opts.model,
		agent: opts.agent,
		workspaceRoot,
		structuredTasksFile,
		milestoneFilter,
		logFile: logFilePath,
	};
	saveState(state);

	// Initialize history
	const history: RalphHistory = {
		iterations: [],
		totalDurationMs: 0,
		struggleIndicators: {
			repeatedErrors: {},
			noProgressIterations: 0,
			shortIterations: 0,
		},
	};
	saveHistory(history);

	// Track subprocess for cleanup
	let currentProc: ReturnType<typeof Bun.spawn> | null = null;
	let caffeinateProc: ReturnType<typeof Bun.spawn> | null = null;
	let stopping = false;

	// Prevent Mac from sleeping while the loop runs
	if (process.platform === "darwin") {
		try {
			caffeinateProc = Bun.spawn(["caffeinate", "-i"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			console.log("☕ Sleep prevention enabled (caffeinate)");
		} catch {
			console.log(
				"⚠️  Could not start caffeinate - Mac may sleep during long iterations",
			);
		}
	}

	const stopCaffeinate = () => {
		if (caffeinateProc) {
			try {
				caffeinateProc.kill();
			} catch {}
			caffeinateProc = null;
		}
	};

	process.on("SIGINT", () => {
		if (stopping) {
			console.log("\nForce stopping...");
			stopCaffeinate();
			process.exit(1);
		}
		stopping = true;
		console.log("\nStopping Ralph loop...");
		if (currentProc) {
			try {
				currentProc.kill("SIGKILL");
			} catch {}
		}
		stopCaffeinate();
		clearState();
		console.log("Loop cancelled.");
		process.exit(0);
	});

	// Main loop
	while (true) {
		if (opts.iterations > 0 && state.iteration > opts.iterations) {
			console.log(
				`\n╔══════════════════════════════════════════════════════════════════╗`,
			);
			console.log(`║  Max iterations (${opts.iterations}) reached`);
			console.log(
				`║  Total time: ${formatDurationLong(history.totalDurationMs)}`,
			);
			console.log(
				`╚══════════════════════════════════════════════════════════════════╝`,
			);
			stopCaffeinate();
			clearState();
			break;
		}

		const iterInfo = opts.iterations > 0 ? ` / ${opts.iterations}` : "";
		const totalElapsed = formatDuration(
			Date.now() - new Date(state.startedAt).getTime(),
		);
		const iterHeader = `\n🔄 Iteration ${state.iteration}${iterInfo} (${totalElapsed})`;
		console.log(iterHeader);
		appendToLog(`${iterHeader}\n`);

		if (structuredTasksFile) {
			const summary = getStructuredTasksSummary(milestoneFilter);
			const nextTask = getNextStructuredTask(milestoneFilter);
			const failedInfo =
				summary.failed > 0 ? ` | Failed: ${summary.failed}` : "";
			const blockedInfo =
				summary.blocked > 0 ? ` | Blocked: ${summary.blocked}` : "";
			const taskLine = `   Tasks: ${summary.completed}/${summary.total}${failedInfo}${blockedInfo} | Next: ${nextTask?.id || "NONE"}`;
			console.log(taskLine);
			appendToLog(`${taskLine}\n`);
		}
		console.log("─".repeat(68));
		appendToLog(`${"─".repeat(68)}\n`);

		const contextAtStart = loadContext();
		const snapshotBefore = await captureFileSnapshot();
		const fullPrompt = buildPrompt(state, agentConfig);
		const iterationStart = Date.now();

		try {
			const cmdArgs = agentConfig.buildArgs(fullPrompt, opts.model, {
				allowAllPermissions: !opts.interactive,
			});
			const env = agentConfig.buildEnv({
				filterPlugins: opts.noPlugins,
				allowAllPermissions: !opts.interactive,
			});

			currentProc = Bun.spawn([agentConfig.command, ...cmdArgs], {
				env,
				cwd: workspaceRoot,
				stdin: "inherit",
				stdout: "pipe",
				stderr: "pipe",
			});

			let result = "";
			let stderr = "";
			let toolCounts = new Map<string, number>();
			let timedOut = false;

			if (!opts.quiet) {
				console.log("⏳ Starting agent...");
				appendToLog("⏳ Starting agent...\n");
				const streamed = await streamProcessOutput(currentProc, {
					compactTools: !opts.verbose,
					toolSummaryIntervalMs: 3000,
					heartbeatIntervalMs: 10000,
					iterationStart,
					agent: agentConfig,
					inactivityTimeoutMs: opts.timeout * 60 * 1000,
					logLine: appendToLog,
				});
				result = streamed.stdoutText;
				stderr = streamed.stderrText;
				toolCounts = streamed.toolCounts;
				timedOut = streamed.timedOut;
			} else {
				const stdoutPromise = new Response(
					currentProc.stdout as ReadableStream<Uint8Array>,
				).text();
				const stderrPromise = new Response(
					currentProc.stderr as ReadableStream<Uint8Array>,
				).text();
				[result, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
			}

			const exitCode = await currentProc.exited;
			currentProc = null;

			if (timedOut) {
				const timeoutMsg = `\n⚠️  Process killed due to inactivity timeout (${opts.timeout} minutes)`;
				console.log(timeoutMsg);
				appendToLog(`${timeoutMsg}\n`);
			}

			const combinedOutput = `${result}\n${stderr}`;
			const completionDetected = new RegExp(
				`<promise>\\s*${escapeRegex(opts.done)}\\s*</promise>`,
				"i",
			).test(combinedOutput);
			const taskCompletionDetected = new RegExp(
				`<promise>\\s*${escapeRegex(opts.next)}\\s*</promise>`,
				"i",
			).test(combinedOutput);
			const milestoneFailedDetected =
				/<promise>\s*MILESTONE_FAILED\s*<\/promise>/i.test(combinedOutput);

			// Parse suggested tasks
			const suggestedTasks = parseSuggestedTasks(combinedOutput);
			if (suggestedTasks.length > 0)
				appendSuggestedTasks(suggestedTasks, state.iteration);

			const iterationDuration = Date.now() - iterationStart;

			// Print summary
			const iterSummary = `
Iteration Summary
${"─".repeat(68)}
Iteration: ${state.iteration}
Elapsed:   ${formatDuration(iterationDuration)}
Tools:     ${formatToolSummary(toolCounts) || "none"}
Exit code: ${exitCode}
Completion: ${completionDetected ? "detected" : "not detected"}
`;
			console.log(iterSummary);
			appendToLog(iterSummary);

			// Track history
			const snapshotAfter = await captureFileSnapshot();
			const filesModified = getModifiedFilesSinceSnapshot(
				snapshotBefore,
				snapshotAfter,
			);
			const errors = extractErrors(combinedOutput);

			history.iterations.push({
				iteration: state.iteration,
				startedAt: new Date(iterationStart).toISOString(),
				endedAt: new Date().toISOString(),
				durationMs: iterationDuration,
				toolsUsed: Object.fromEntries(toolCounts),
				filesModified,
				exitCode,
				completionDetected,
				errors,
			});
			history.totalDurationMs += iterationDuration;

			// Update struggle indicators
			const madeProgress =
				filesModified.length > 0 ||
				taskCompletionDetected ||
				completionDetected;
			if (!madeProgress) history.struggleIndicators.noProgressIterations++;
			else history.struggleIndicators.noProgressIterations = 0;

			if (iterationDuration < 30000)
				history.struggleIndicators.shortIterations++;
			else history.struggleIndicators.shortIterations = 0;

			if (errors.length === 0) history.struggleIndicators.repeatedErrors = {};
			else {
				for (const error of errors) {
					const key = error.substring(0, 100);
					history.struggleIndicators.repeatedErrors[key] =
						(history.struggleIndicators.repeatedErrors[key] || 0) + 1;
				}
			}
			saveHistory(history);

			// Check completion
			if (completionDetected) {
				console.log(
					`\n╔══════════════════════════════════════════════════════════════════╗`,
				);
				console.log(`║  ✅ Completion detected!`);
				console.log(`║  Completed in ${state.iteration} iteration(s)`);
				console.log(
					`║  Total time: ${formatDurationLong(history.totalDurationMs)}`,
				);
				console.log(
					`╚══════════════════════════════════════════════════════════════════╝`,
				);

				if (milestoneFilter) {
					try {
						const tagName = `${milestoneFilter.toLowerCase()}-complete`;
						await $`git tag -a ${tagName} -m "Milestone ${milestoneFilter} completed"`.quiet();
						console.log(`🏷️  Tagged: ${tagName}`);
					} catch {}
				}

				stopCaffeinate();
				clearState();
				clearHistory();
				clearContext();
				break;
			}

			if (milestoneFailedDetected) {
				const failure = isMilestoneFailed(state.milestoneFilter);
				const failedNames = failure.failedTasks.map(
					(t) => `${t.id}${t.failedReason ? ` (${t.failedReason})` : ""}`,
				);
				const blockedNames = failure.blockedTasks.map((t) => t.id);

				console.log(
					`\n╔══════════════════════════════════════════════════════════════════╗`,
				);
				console.log(`║  ❌ Milestone ${state.milestoneFilter || "ALL"} FAILED`);
				console.log(`║  After ${state.iteration} iteration(s)`);
				console.log(
					`║  Total time: ${formatDurationLong(history.totalDurationMs)}`,
				);
				console.log(`║`);
				console.log(`║  Failed tasks:`);
				for (const name of failedNames) {
					console.log(`║    - ${name}`);
				}
				if (blockedNames.length > 0) {
					console.log(`║  Blocked tasks:`);
					for (const name of blockedNames) {
						console.log(`║    - ${name}`);
					}
				}
				console.log(`║`);
				console.log(`║  Server still running on http://localhost:${port}`);
				console.log(`║  Use MCP tools to review, then Ctrl+C to exit.`);
				console.log(
					`╚══════════════════════════════════════════════════════════════════╝`,
				);

				if (milestoneFilter) {
					try {
						const tagName = `${milestoneFilter.toLowerCase()}-failed`;
						await $`git tag -a ${tagName} -m "Milestone ${milestoneFilter} failed"`.quiet();
						console.log(`🏷️  Tagged: ${tagName}`);
					} catch {}
				}

				stopCaffeinate();
				state.active = false;
				saveState(state);

				await new Promise(() => {});
			}

			if (contextAtStart) {
				console.log(`📝 Context consumed`);
				clearContext();
			}

			// Auto-commit
			if (!opts.noCommit) {
				try {
					const status = await $`git status --porcelain`.text();
					if (status.trim()) {
						await $`git add -A`;
						await $`git commit -m "Ralph iteration ${state.iteration}: work in progress"`.quiet();
						console.log(`📝 Auto-committed`);
					}
				} catch {}
			}

			// Code review after each iteration (opencode agent only)
			if (opts.agent === "opencode") {
				const reviewOutput = await runCodeReview(
					workspaceRoot,
					opts.timeout * 60 * 1000,
				);
				if (reviewOutput) {
					if (
						/<review-result>\s*ISSUES\s*<\/review-result>/i.test(reviewOutput)
					) {
						console.log("⚠️  Review found issues — injecting as context");
						const timestamp = new Date().toISOString();
						const entry = `\n## Code review at ${timestamp}\n${reviewOutput}\n`;
						const contextPath = getContextPath();
						if (existsSync(contextPath)) {
							writeFileSync(
								contextPath,
								readFileSync(contextPath, "utf-8") + entry,
							);
						} else {
							writeFileSync(contextPath, `# Ralph Loop Context\n${entry}`);
						}
					} else if (
						/<review-result>\s*PASS\s*<\/review-result>/i.test(reviewOutput)
					) {
						console.log("✅ Code review passed");
					}
				}
			}

			state.iteration++;
			saveState(state);
			await new Promise((r) => setTimeout(r, 1000));
		} catch (error) {
			if (currentProc) {
				try {
					currentProc.kill("SIGKILL");
				} catch {}
				currentProc = null;
			}
			console.error(`\n❌ Error in iteration ${state.iteration}:`, error);
			console.log("Continuing to next iteration...");

			history.iterations.push({
				iteration: state.iteration,
				startedAt: new Date(iterationStart).toISOString(),
				endedAt: new Date().toISOString(),
				durationMs: Date.now() - iterationStart,
				toolsUsed: {},
				filesModified: [],
				exitCode: -1,
				completionDetected: false,
				errors: [String(error).substring(0, 200)],
			});
			history.totalDurationMs += Date.now() - iterationStart;
			saveHistory(history);

			state.iteration++;
			saveState(state);
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));

	// Handle global flags
	if (parsed.flags.version) {
		console.log(`chief-wiggum ${VERSION}`);
		process.exit(0);
	}

	if (parsed.flags.help) {
		switch (parsed.command) {
			case "run":
				console.log(HELP_RUN);
				break;
			case "status":
				console.log(HELP_STATUS);
				break;
			case "context":
				console.log(HELP_CONTEXT);
				break;
			case "tasks":
				console.log(HELP_TASKS);
				break;
			case "assist":
				console.log(HELP_ASSIST);
				break;
			default:
				console.log(HELP_MAIN);
		}
		process.exit(0);
	}

	// Default to run command if args/flags suggest it
	if (!parsed.command) {
		parsed.command = "run";
	}

	// Route to command
	switch (parsed.command) {
		case "status":
			cmdStatus(parsed.flags);
			break;
		case "context":
			cmdContext(parsed.args, parsed.flags);
			break;
		case "tasks":
			cmdTasks(parsed.args, parsed.flags);
			break;
		case "assist":
			await cmdAssist(parsed.flags);
			break;
		case "serve":
			await cmdServe(parsed.flags);
			break;
		default:
			await cmdRun(parsed.args, parsed.flags);
			break;
	}
}

main().catch((error) => {
	console.error("Fatal error:", error);
	clearState();
	process.exit(1);
});
