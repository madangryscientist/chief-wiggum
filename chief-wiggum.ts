#!/usr/bin/env bun

/**
 * Chief Wiggum - Iterative AI development loop
 *
 * Fork of Ralph Wiggum with enhanced task management, worktree support,
 * and structured milestone tracking. Based on ghuntley.com/ralph/
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
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
	status: "todo" | "in-progress" | "complete";
	depends: string[];
	verify: string | null;
	started: string | null;
	completed: string | null;
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
	startedAt: string;
	model: string;
	agent: AgentType;
	workspaceRoot?: string;
	structuredTasksFile?: string | null;
	milestoneFilter?: string | null;
	logFile?: string | null;
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
// Globals
// ============================================================================

let workspaceRoot = process.cwd();
let structuredTasksFile: string | null = null;
let milestoneFilter: string | null = null;
let logFilePath: string | null = null;

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
	"--count": { key: "count", hasValue: true, default: "5" },
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
	"--clear": { key: "clear", hasValue: false },
};

const COMMANDS = ["run", "status", "context", "tasks", "logs"];

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
  status           Show loop status and history  
  context <text>   Add context for next iteration
  tasks            List/manage tasks
  logs             Summarize and manage logs

Run 'chief-wiggum <command> --help' for command-specific help.

Examples:
  chief-wiggum run -f prompt.md -t docs/tasks.md -M M2b
  chief-wiggum status
  chief-wiggum context "focus on the auth module"
  chief-wiggum tasks add "fix the login bug"
  chief-wiggum logs
`;

const HELP_RUN = `
chief-wiggum run - Start the Ralph loop

Usage:
  chief-wiggum run [options] [prompt]
  chief-wiggum -f <file> [options]

Core Options:
  -f, --prompt <file>     Prompt file path
  -n, --iterations <n>    Max iterations (0=unlimited, default: 0)
  -m, --model <name>      Model to use (default: anthropic/claude-opus-4-5)
  -a, --agent <type>      Agent: opencode (default), claude-code, codex

Tasks:
  -t, --tasks-file <path> Structured tasks file (e.g., docs/tasks.md)  
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
  --log                   Log output to .ralph/logs/

Examples:
  chief-wiggum run -f prompt.md -t docs/tasks.md -M M2b -n 50
  chief-wiggum run "Fix the auth bug" --timeout 15
  chief-wiggum run -f prompt.md --force --log
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

const HELP_LOGS = `
chief-wiggum logs - Summarize and manage log files

Usage:
  chief-wiggum logs              Summarize recent logs
  chief-wiggum logs archive      Archive old logs to .ralph/logs/archive/

Options:
  -w, --workspace <dir>   Target different directory
  -n, --count <n>         Number of recent logs to show (default: 5)

Examples:
  chief-wiggum logs
  chief-wiggum logs -n 10
  chief-wiggum logs archive
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
			/^-\s+\[([ x/])\]\s+([a-zA-Z0-9_-]+):\s*(.+)$/,
		);
		if (taskMatch) {
			saveCurrentTask();
			const [, statusChar, id, title] = taskMatch;
			let status: StructuredTask["status"] = "todo";
			if (statusChar === "x") status = "complete";
			else if (statusChar === "/") status = "in-progress";

			currentTask = {
				id,
				title,
				milestone: currentMilestone,
				status,
				depends: [],
				verify: null,
				started: null,
				completed: null,
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

	for (const task of tasks) {
		if (task.status !== "todo" && task.status !== "in-progress") continue;
		const allDepsComplete = task.depends.every((depId) => {
			const dep = data.allTasks.get(depId);
			return dep?.status === "complete";
		});
		if (allDepsComplete) return task;
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

function getStructuredTasksSummary(milestone: string | null): {
	pending: number;
	inProgress: number;
	completed: number;
	total: number;
} {
	const data = loadStructuredTasks();
	if (!data) return { pending: 0, inProgress: 0, completed: 0, total: 0 };

	let tasks: StructuredTask[];
	if (milestone) {
		tasks = data.milestones.get(milestone) || [];
	} else {
		tasks = Array.from(data.allTasks.values());
	}

	const pending = tasks.filter((t) => t.status === "todo").length;
	const inProgress = tasks.filter((t) => t.status === "in-progress").length;
	const completed = tasks.filter((t) => t.status === "complete").length;
	return { pending, inProgress, completed, total: tasks.length };
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

		const data = loadStructuredTasks();
		let tasks: StructuredTask[] = [];
		if (data) {
			if (state.milestoneFilter) {
				tasks = data.milestones.get(state.milestoneFilter) || [];
			} else {
				tasks = Array.from(data.allTasks.values());
			}
		}

		const taskList = tasks
			.map((t) => {
				const statusIcon =
					t.status === "complete"
						? "✅"
						: t.status === "in-progress"
							? "🔄"
							: "⏸️";
				const deps = t.depends.length
					? ` (depends: ${t.depends.join(", ")})`
					: "";
				return `${statusIcon} ${t.id}: ${t.title}${deps}`;
			})
			.join("\n");

		let taskInstructions = "";
		if (allComplete) {
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

**Summary:** ${summary.completed}/${summary.total} complete, ${summary.inProgress} in progress, ${summary.pending} pending

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

	const maybePrintToolSummary = (force = false) => {
		if (!options.compactTools || toolCounts.size === 0) return;
		const now = Date.now();
		if (!force && now - lastToolSummaryAt < options.toolSummaryIntervalMs)
			return;
		const summary = formatToolSummary(toolCounts);
		if (summary) {
			console.log(`| Tools    ${summary}`);
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
			console.log("");
			lastPrintedAt = Date.now();
			return;
		}
		if (isError) console.error(line);
		else console.log(line);
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
				console.log(
					`\n⏰ INACTIVITY TIMEOUT: No output for ${formatDuration(inactivityDuration)}. Sending SIGTERM...`,
				);
				try {
					proc.kill("SIGTERM");
				} catch {}
			} else if (killAttempts === 2) {
				console.log(`⏰ Process didn't respond to SIGTERM. Sending SIGKILL...`);
				try {
					proc.kill("SIGKILL");
				} catch {}
			} else if (killAttempts === 3) {
				console.log(`⏰ Killing process tree (PID: ${proc.pid})...`);
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
			console.log(
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
		console.log(`⏰ Force-exiting stream readers after timeout`);
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
// Command: logs
// ============================================================================

interface LogFileSummary {
	filename: string;
	path: string;
	milestone: string;
	timestamp: Date;
	sizeBytes: number;
	lineCount: number;
	iterations: number;
	toolsUsed: Record<string, number>;
	duration: string | null;
}

function parseLogFile(filePath: string): LogFileSummary | null {
	try {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		const filename = filePath.split("/").pop() || "";

		// Parse filename: <milestone>-<timestamp>.log
		const match = filename.match(/^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.log$/);
		const milestone = match?.[1] || "unknown";
		const timestampStr = match?.[2]?.replace(/-/g, (m, i) => (i > 9 ? ":" : "-")) || "";
		const timestamp = new Date(timestampStr.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3"));

		// Count iterations
		const iterationMatches = content.match(/🔄 Iteration \d+/g);
		const iterations = iterationMatches?.length || 0;

		// Parse tools used
		const toolsUsed: Record<string, number> = {};
		const toolMatches = content.matchAll(/\| Tools\s+(.+)/g);
		for (const toolMatch of toolMatches) {
			const toolLine = toolMatch[1];
			const toolParts = toolLine.split("•").map((s) => s.trim());
			for (const part of toolParts) {
				const [name, countStr] = part.split(/\s+/);
				if (name && countStr) {
					const count = parseInt(countStr, 10) || 0;
					toolsUsed[name] = (toolsUsed[name] || 0) + count;
				}
			}
		}

		// Try to find duration
		const durationMatch = content.match(/Total time:\s+(.+)/);
		const duration = durationMatch?.[1] || null;

		const stats = Bun.file(filePath);

		return {
			filename,
			path: filePath,
			milestone,
			timestamp,
			sizeBytes: stats.size,
			lineCount: lines.length,
			iterations,
			toolsUsed,
			duration,
		};
	} catch {
		return null;
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function cmdLogs(
	args: string[],
	flags: Record<string, string | boolean>,
): Promise<void> {
	if (flags.workspace) workspaceRoot = flags.workspace as string;

	const logDir = getLogDir();
	const subcommand = args[0] || "list";

	if (subcommand === "archive") {
		// Archive old logs
		if (!existsSync(logDir)) {
			console.log("ℹ️  No logs directory found");
			return;
		}

		const archiveDir = join(logDir, "archive");
		if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });

		const files = await Array.fromAsync(
			new Bun.Glob("*.log").scan({ cwd: logDir, onlyFiles: true }),
		);

		if (files.length === 0) {
			console.log("ℹ️  No log files to archive");
			return;
		}

		// Keep the 5 most recent, archive the rest
		const summaries = files
			.map((f) => parseLogFile(join(logDir, f)))
			.filter((s): s is LogFileSummary => s !== null)
			.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

		const toArchive = summaries.slice(5);
		if (toArchive.length === 0) {
			console.log("ℹ️  Only 5 or fewer logs exist, nothing to archive");
			return;
		}

		// Calculate stats from ALL logs (not just the ones being archived)
		let totalSize = 0;
		let totalIterations = 0;
		const allToolsUsed: Record<string, number> = {};

		for (const log of summaries) {
			totalSize += log.sizeBytes;
			totalIterations += log.iterations;
			for (const [tool, count] of Object.entries(log.toolsUsed)) {
				allToolsUsed[tool] = (allToolsUsed[tool] || 0) + count;
			}
		}

		// Move old logs to archive
		let archivedSize = 0;
		for (const log of toArchive) {
			const src = log.path;
			const dest = join(archiveDir, log.filename);
			copyFileSync(src, dest);
			unlinkSync(src);
			archivedSize += log.sizeBytes;
		}

		// Generate summary file from ALL logs
		const archiveTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const summaryPath = join(archiveDir, `archive-summary-${archiveTimestamp}.md`);

		const topTools = Object.entries(allToolsUsed)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([name, count]) => `- ${name}: ${count}`)
			.join("\n");

		const milestones = [...new Set(summaries.map((l) => l.milestone))];

		const summaryContent = `# Archive Summary

**Archived:** ${new Date().toLocaleString()}
**Files:** ${summaries.length}
**Total Size:** ${formatBytes(totalSize)}
**Total Iterations:** ${totalIterations}
**Milestones:** ${milestones.join(", ")}

## Top Tools Used

${topTools || "No tool usage recorded"}

## All Log Files

| File | Milestone | Iterations | Size |
|------|-----------|------------|------|
${summaries.map((log) => `| ${log.filename} | ${log.milestone} | ${log.iterations} | ${formatBytes(log.sizeBytes)} |`).join("\n")}
`;

		writeFileSync(summaryPath, summaryContent);

		console.log(`✅ Archived ${toArchive.length} log files (${formatBytes(archivedSize)})`);
		console.log(`   Location: ${archiveDir}`);
		console.log(`   Summary:  ${summaryPath.split("/").pop()} (all ${summaries.length} logs)`);
		return;
	}

	// Default: summarize logs
	if (!existsSync(logDir)) {
		console.log("ℹ️  No logs directory found");
		console.log("   Run with --log flag to enable logging");
		return;
	}

	const files = await Array.fromAsync(
		new Bun.Glob("*.log").scan({ cwd: logDir, onlyFiles: true }),
	);

	if (files.length === 0) {
		console.log("ℹ️  No log files found");
		return;
	}

	const count = parseInt((flags.count as string) || "5", 10) || 5;

	const summaries = files
		.map((f) => parseLogFile(join(logDir, f)))
		.filter((s): s is LogFileSummary => s !== null)
		.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
		.slice(0, count);

	console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    Ralph Loop - Log Summary                      ║
╚══════════════════════════════════════════════════════════════════╝
`);

	console.log(`Found ${files.length} log files, showing ${summaries.length} most recent:\n`);

	for (const log of summaries) {
		const topTools = Object.entries(log.toolsUsed)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 4)
			.map(([name, count]) => `${name}:${count}`)
			.join(" ");

		console.log(`📄 ${log.filename}`);
		console.log(`   Milestone:   ${log.milestone}`);
		console.log(`   Date:        ${log.timestamp.toLocaleString()}`);
		console.log(`   Iterations:  ${log.iterations}`);
		console.log(`   Size:        ${formatBytes(log.sizeBytes)} (${log.lineCount} lines)`);
		if (log.duration) console.log(`   Duration:    ${log.duration}`);
		if (topTools) console.log(`   Top Tools:   ${topTools}`);
		console.log("");
	}

	// Show total stats
	const totalSize = summaries.reduce((sum, log) => sum + log.sizeBytes, 0);
	const totalIterations = summaries.reduce((sum, log) => sum + log.iterations, 0);

	console.log("─".repeat(68));
	console.log(`Total: ${formatBytes(totalSize)} across ${summaries.length} logs, ${totalIterations} iterations`);

	// Check for archived logs
	const archiveDir = join(logDir, "archive");
	if (existsSync(archiveDir)) {
		const archivedFiles = await Array.fromAsync(
			new Bun.Glob("*.log").scan({ cwd: archiveDir, onlyFiles: true }),
		);
		if (archivedFiles.length > 0) {
			console.log(`\n📦 ${archivedFiles.length} archived logs in ${archiveDir}`);
		}
	}

	if (files.length > count) {
		console.log(`\nUse 'chief-wiggum logs -n ${files.length}' to see all logs`);
		console.log(`Use 'chief-wiggum logs archive' to archive old logs`);
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
		log: !!flags.log,
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
	}

	if (!opts.prompt) {
		console.error("Error: No prompt provided");
		console.error("Usage: chief-wiggum run -f <file> [options]");
		console.error("       chief-wiggum run <prompt> [options]");
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
		console.log(`\n🔄 Iteration ${state.iteration}${iterInfo}`);

		if (structuredTasksFile) {
			const summary = getStructuredTasksSummary(milestoneFilter);
			const nextTask = getNextStructuredTask(milestoneFilter);
			console.log(
				`   Tasks: ${summary.completed}/${summary.total} | Next: ${nextTask?.id || "NONE"}`,
			);
		}
		console.log("─".repeat(68));

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
				const streamed = await streamProcessOutput(currentProc, {
					compactTools: !opts.verbose,
					toolSummaryIntervalMs: 3000,
					heartbeatIntervalMs: 10000,
					iterationStart,
					agent: agentConfig,
					inactivityTimeoutMs: opts.timeout * 60 * 1000,
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
				console.log(
					`\n⚠️  Process killed due to inactivity timeout (${opts.timeout} minutes)`,
				);
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

			// Parse suggested tasks
			const suggestedTasks = parseSuggestedTasks(combinedOutput);
			if (suggestedTasks.length > 0)
				appendSuggestedTasks(suggestedTasks, state.iteration);

			const iterationDuration = Date.now() - iterationStart;

			// Print summary
			console.log("\nIteration Summary");
			console.log("─".repeat(68));
			console.log(`Iteration: ${state.iteration}`);
			console.log(`Elapsed:   ${formatDuration(iterationDuration)}`);
			console.log(`Tools:     ${formatToolSummary(toolCounts) || "none"}`);
			console.log(`Exit code: ${exitCode}`);
			console.log(
				`Completion: ${completionDetected ? "detected" : "not detected"}`,
			);

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
			case "logs":
				console.log(HELP_LOGS);
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
		case "logs":
			await cmdLogs(parsed.args, parsed.flags);
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
