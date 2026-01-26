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

const VERSION = "2.0.0";

// ============================================================================
// Types
// ============================================================================

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
	workspaceRoot?: string;
	structuredTasksFile?: string | null;
	milestoneFilter?: string | null;
	loopId?: string | null;
}

// ============================================================================
// Globals
// ============================================================================

let workspaceRoot = process.cwd();
let structuredTasksFile: string | null = null;

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
	"--count": { key: "count", hasValue: true, default: "5" },
	"--lines": { key: "lines", hasValue: true, default: "1000" },
	"-t": { key: "tasksFile", hasValue: true },
	"--tasks-file": { key: "tasksFile", hasValue: true },
	"-M": { key: "milestone", hasValue: true },
	"--milestone": { key: "milestone", hasValue: true },
	"-w": { key: "workspace", hasValue: true },
	"--workspace": { key: "workspace", hasValue: true },
	"--clear": { key: "clear", hasValue: false },
	"--json": { key: "json", hasValue: false },
	"-p": { key: "port", hasValue: true, default: "3456" },
	"--port": { key: "port", hasValue: true, default: "3456" },
};

const COMMANDS = [
	"status",
	"context",
	"tasks",
	"logs",
	"summary",
	"stop",
	"serve",
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
Chief Wiggum v${VERSION} - State manager for iterative AI development

Usage:
  chief-wiggum [command] [options]

Commands:
  status           Show loop status and history  
  context <text>   Add context for next iteration
  tasks            List/manage tasks
  logs             Print recent log output / archive logs
  summary          Generate summaries (logs, suggested tasks)
  stop             Stop an active loop
  serve            Start HTTP server for state management

Global Options:
  --json           Output as JSON (for programmatic use)

Run 'chief-wiggum <command> --help' for command-specific help.

Examples:
  chief-wiggum status
  chief-wiggum status --json
  chief-wiggum context "focus on the auth module"
  chief-wiggum tasks --json
  chief-wiggum logs
  chief-wiggum summary logs
  chief-wiggum stop
  chief-wiggum serve --port 3456
`;

const HELP_STATUS = `
chief-wiggum status - Show Ralph loop status and history

Usage:
  chief-wiggum status [options]

Options:
  -w, --workspace <dir>   Check status in different directory
  --json                  Output as JSON

Examples:
  chief-wiggum status
  chief-wiggum status --json
  chief-wiggum status -w ~/projects/my-app
`;

const HELP_CONTEXT = `
chief-wiggum context - Add context for next Ralph iteration

Usage:
  chief-wiggum context <text>    Add context text
  chief-wiggum context --clear   Clear pending context
  chief-wiggum context --json    Get current context as JSON (no text arg)

Options:
  -w, --workspace <dir>   Target different directory
  --json                  Output as JSON

Examples:
  chief-wiggum context "Focus on the auth module first"
  chief-wiggum context --clear
  chief-wiggum context --json
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
  --json                  Output as JSON

Examples:
  chief-wiggum tasks
  chief-wiggum tasks --json
  chief-wiggum tasks add "implement user login"
  chief-wiggum tasks rm 3
`;

const HELP_LOGS = `
chief-wiggum logs - Print recent log output and manage log files

Usage:
  chief-wiggum logs              Print last 1000 lines of current log
  chief-wiggum logs archive      Archive old logs to .ralph/logs/archive/

Options:
  -w, --workspace <dir>   Target different directory
  -n, --lines <n>         Number of lines to show (default: 1000)

Examples:
  chief-wiggum logs
  chief-wiggum logs -n 500
  chief-wiggum logs archive
`;

const HELP_SUMMARY = `
chief-wiggum summary - Generate summaries

Usage:
  chief-wiggum summary logs      Generate summary of all logs (includes archived)
  chief-wiggum summary suggest   Show suggested tasks from Ralph loop

Options:
  -w, --workspace <dir>   Target different directory

Examples:
  chief-wiggum summary logs
  chief-wiggum summary suggest
`;

const HELP_STOP = `
chief-wiggum stop - Stop an active Ralph loop

Usage:
  chief-wiggum stop [options]

Options:
  -w, --workspace <dir>   Target different directory
  --json                  Output result as JSON

Examples:
  chief-wiggum stop
  chief-wiggum stop --json
`;

// ============================================================================
// Utility functions
// ============================================================================

import { formatDurationLong } from "./utils";

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
			/^-\s+\[([ x/])\]\s+`?([a-zA-Z0-9_-]+)`?\s+(.+)$/,
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

function updateStructuredTaskStatus(
	taskId: string,
	newStatus: "todo" | "in-progress" | "complete",
): { success: boolean; error?: string } {
	if (!structuredTasksFile) {
		return { success: false, error: "No structured tasks file configured" };
	}

	const fullPath = join(workspaceRoot, structuredTasksFile);
	if (!existsSync(fullPath)) {
		return { success: false, error: "Tasks file not found" };
	}

	const content = readFileSync(fullPath, "utf-8");
	const lines = content.split("\n");
	const newLines: string[] = [];
	let found = false;
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const taskMatch = line.match(
			/^(-\s+\[)([ x/])(\]\s+`?)([a-zA-Z0-9_-]+)(`?\s+.+)$/,
		);

		if (taskMatch && taskMatch[4] === taskId) {
			found = true;
			const statusChar =
				newStatus === "complete"
					? "x"
					: newStatus === "in-progress"
						? "/"
						: " ";
			newLines.push(
				`${taskMatch[1]}${statusChar}${taskMatch[3]}${taskMatch[4]}${taskMatch[5]}`,
			);
			i++;

			// Check for existing metadata lines
			const hasStarted = i < lines.length && lines[i].match(/^\s+-\s+started:/);
			const hasCompleted =
				i < lines.length &&
				lines[i + (hasStarted ? 1 : 0)]?.match(/^\s+-\s+completed:/);

			// Add or update metadata
			if (newStatus === "in-progress" && !hasStarted) {
				newLines.push(`  - started: ${new Date().toISOString()}`);
			}

			// Copy existing metadata lines
			while (i < lines.length && lines[i].match(/^\s+-\s+\w+:/)) {
				const metaLine = lines[i];
				if (newStatus === "complete" && metaLine.match(/^\s+-\s+completed:/)) {
					// Skip old completed line, we'll add new one
					i++;
					continue;
				}
				newLines.push(metaLine);
				i++;
			}

			// Add completed timestamp if marking complete
			if (newStatus === "complete" && !hasCompleted) {
				newLines.push(`  - completed: ${new Date().toISOString()}`);
			}
		} else {
			newLines.push(line);
			i++;
		}
	}

	if (!found) {
		return { success: false, error: `Task not found: ${taskId}` };
	}

	writeFileSync(fullPath, newLines.join("\n"));
	return { success: true };
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

// ============================================================================
// Prompt building
// ============================================================================

function buildPrompt(state: RalphState): string {
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
// Command: status
// ============================================================================

function cmdStatus(flags: Record<string, string | boolean>): void {
	if (flags.workspace) workspaceRoot = flags.workspace as string;

	const state = loadState();
	const history = loadHistory();
	const context = loadContext();

	if (flags.json) {
		console.log(
			JSON.stringify({
				active: state?.active ?? false,
				state: state ?? null,
				history: history ?? null,
				context: context ?? null,
			}),
		);
		return;
	}

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
		if (state.loopId) console.log(`   Loop ID:      ${state.loopId}`);
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
			if (flags.json) {
				console.log(JSON.stringify({ success: true, action: "cleared" }));
			} else {
				console.log(`✅ Context cleared`);
			}
		} else {
			if (flags.json) {
				console.log(JSON.stringify({ success: true, action: "no_context" }));
			} else {
				console.log(`ℹ️  No pending context to clear`);
			}
		}
		return;
	}

	const contextText = args.join(" ");
	if (!contextText) {
		if (flags.json) {
			const context = loadContext();
			console.log(JSON.stringify({ context: context ?? null }));
			return;
		}
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

	if (flags.json) {
		console.log(JSON.stringify({ success: true, action: "added" }));
		return;
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
			const allTasks = Array.from(data.allTasks.values());
			const complete = allTasks.filter((t) => t.status === "complete").length;
			const inProgress = allTasks.filter(
				(t) => t.status === "in-progress",
			).length;
			const todo = allTasks.filter((t) => t.status === "todo").length;

			if (flags.json) {
				console.log(
					JSON.stringify({
						total: allTasks.length,
						complete,
						inProgress,
						todo,
						tasks: allTasks,
					}),
				);
				return;
			}

			console.log("Structured Tasks:\n");
			for (const [milestone, tasks] of data.milestones) {
				const completeCount = tasks.filter(
					(t) => t.status === "complete",
				).length;
				console.log(`## ${milestone} (${completeCount}/${tasks.length})`);
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
		if (flags.json) {
			console.log(
				JSON.stringify({
					total: 0,
					complete: 0,
					inProgress: 0,
					todo: 0,
					tasks: [],
				}),
			);
			return;
		}
		console.log("No tasks file found.");
		console.log("Use 'chief-wiggum tasks add <description>' to create tasks.");
		return;
	}

	const content = readFileSync(tasksPath, "utf-8");
	const tasks = parseTasks(content);

	if (flags.json) {
		const complete = tasks.filter((t) => t.status === "complete").length;
		const inProgress = tasks.filter((t) => t.status === "in-progress").length;
		const todo = tasks.filter((t) => t.status === "todo").length;
		console.log(
			JSON.stringify({
				total: tasks.length,
				complete,
				inProgress,
				todo,
				tasks,
			}),
		);
		return;
	}

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
// Command: stop
// ============================================================================

function cmdStop(flags: Record<string, string | boolean>): void {
	if (flags.workspace) workspaceRoot = flags.workspace as string;

	const state = loadState();

	if (!state?.active) {
		if (flags.json) {
			console.log(
				JSON.stringify({ success: false, error: "No active loop to stop" }),
			);
		} else {
			console.log(`ℹ️  No active loop to stop`);
		}
		return;
	}

	state.active = false;
	saveState(state);

	if (flags.json) {
		console.log(
			JSON.stringify({
				success: true,
				stoppedAt: new Date().toISOString(),
				iteration: state.iteration,
			}),
		);
	} else {
		console.log(`✅ Loop stopped at iteration ${state.iteration}`);
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
		const match = filename.match(
			/^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.log$/,
		);
		const milestone = match?.[1] || "unknown";
		const timestampStr =
			match?.[2]?.replace(/-/g, (m, i) => (i > 9 ? ":" : "-")) || "";
		const timestamp = new Date(
			timestampStr.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3"),
		);

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
	const subcommand = args[0] || "show";

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

		// Move old logs to archive
		let archivedSize = 0;
		for (const log of toArchive) {
			const src = log.path;
			const dest = join(archiveDir, log.filename);
			copyFileSync(src, dest);
			unlinkSync(src);
			archivedSize += log.sizeBytes;
		}

		console.log(
			`✅ Archived ${toArchive.length} log files (${formatBytes(archivedSize)})`,
		);
		console.log(`   Location: ${archiveDir}`);
		return;
	}

	// Default: show last N lines of most recent log
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

	// Find most recent log
	const summaries = files
		.map((f) => parseLogFile(join(logDir, f)))
		.filter((s): s is LogFileSummary => s !== null)
		.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

	if (summaries.length === 0) {
		console.log("ℹ️  No valid log files found");
		return;
	}

	const mostRecent = summaries[0];
	const lineCount = parseInt((flags.lines as string) || "1000", 10) || 1000;

	const content = readFileSync(mostRecent.path, "utf-8");
	const lines = content.split("\n");
	const startLine = Math.max(0, lines.length - lineCount);
	const outputLines = lines.slice(startLine);

	console.log(`📄 ${mostRecent.filename} (last ${outputLines.length} lines)\n`);
	console.log(outputLines.join("\n"));
}

// ============================================================================
// Command: summary
// ============================================================================

async function cmdSummary(
	args: string[],
	flags: Record<string, string | boolean>,
): Promise<void> {
	if (flags.workspace) workspaceRoot = flags.workspace as string;

	const subcommand = args[0];

	if (!subcommand) {
		console.log("Usage: chief-wiggum summary <logs|suggest>");
		console.log("  logs    - Generate summary of all logs");
		console.log("  suggest - Show suggested tasks");
		return;
	}

	if (subcommand === "logs") {
		const logDir = getLogDir();

		if (!existsSync(logDir)) {
			console.log("ℹ️  No logs directory found");
			return;
		}

		// Collect logs from main dir and archive
		const mainFiles = await Array.fromAsync(
			new Bun.Glob("*.log").scan({ cwd: logDir, onlyFiles: true }),
		);
		const mainSummaries = mainFiles
			.map((f) => parseLogFile(join(logDir, f)))
			.filter((s): s is LogFileSummary => s !== null);

		const archiveDir = join(logDir, "archive");
		let archivedSummaries: LogFileSummary[] = [];
		if (existsSync(archiveDir)) {
			const archiveFiles = await Array.fromAsync(
				new Bun.Glob("*.log").scan({ cwd: archiveDir, onlyFiles: true }),
			);
			archivedSummaries = archiveFiles
				.map((f) => parseLogFile(join(archiveDir, f)))
				.filter((s): s is LogFileSummary => s !== null);
		}

		const allSummaries = [...mainSummaries, ...archivedSummaries].sort(
			(a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
		);

		if (allSummaries.length === 0) {
			console.log("ℹ️  No log files found");
			return;
		}

		// Calculate totals
		let totalSize = 0;
		let totalIterations = 0;
		const allToolsUsed: Record<string, number> = {};

		for (const log of allSummaries) {
			totalSize += log.sizeBytes;
			totalIterations += log.iterations;
			for (const [tool, count] of Object.entries(log.toolsUsed)) {
				allToolsUsed[tool] = (allToolsUsed[tool] || 0) + count;
			}
		}

		const topTools = Object.entries(allToolsUsed)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([name, count]) => `- ${name}: ${count}`)
			.join("\n");

		const milestones = [...new Set(allSummaries.map((l) => l.milestone))];

		// Generate summary file
		const summaryTimestamp = new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.slice(0, 19);
		const summaryPath = join(
			getStateDir(),
			`session-summary-${summaryTimestamp}.md`,
		);

		const summaryContent = `# Session Summary

**Generated:** ${new Date().toLocaleString()}
**Log Files:** ${allSummaries.length} (${mainSummaries.length} active, ${archivedSummaries.length} archived)
**Total Size:** ${formatBytes(totalSize)}
**Total Iterations:** ${totalIterations}
**Milestones:** ${milestones.join(", ")}

## Top Tools Used

${topTools || "No tool usage recorded"}

## Log Files

| File | Milestone | Iterations | Size |
|------|-----------|------------|------|
${allSummaries.map((log) => `| ${log.filename} | ${log.milestone} | ${log.iterations} | ${formatBytes(log.sizeBytes)} |`).join("\n")}
`;

		writeFileSync(summaryPath, summaryContent);

		console.log(`✅ Generated session summary`);
		console.log(`   File: ${summaryPath}`);
		console.log(
			`   Logs: ${allSummaries.length} files (${mainSummaries.length} active, ${archivedSummaries.length} archived)`,
		);
		console.log(`   Iterations: ${totalIterations}`);
		console.log(
			`   Tools: ${Object.keys(allToolsUsed).length} unique tools used`,
		);
		return;
	}

	if (subcommand === "suggest") {
		const suggestedTasksPath = getSuggestedTasksPath();

		if (!existsSync(suggestedTasksPath)) {
			console.log("ℹ️  No suggested tasks found");
			console.log(
				"   Suggested tasks are generated during Ralph loop iterations",
			);
			return;
		}

		const content = readFileSync(suggestedTasksPath, "utf-8");
		const taskCount = (content.match(/^- \[ \]/gm) || []).length;

		console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    Ralph Loop - Suggested Tasks                  ║
╚══════════════════════════════════════════════════════════════════╝
`);
		console.log(content);
		console.log("─".repeat(68));
		console.log(`Total: ${taskCount} pending task(s)`);
		console.log(`\nFile: ${suggestedTasksPath}`);
		return;
	}

	console.log(`Unknown subcommand: ${subcommand}`);
	console.log("Usage: chief-wiggum summary <logs|suggest>");
}

// ============================================================================
// Loop ID generation
// ============================================================================

function generateLoopId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `${timestamp}-${random}`;
}

// ============================================================================
// Command: serve
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

function cmdServe(flags: Record<string, string | boolean>): void {
	if (flags.workspace) workspaceRoot = flags.workspace as string;
	if (flags.tasksFile) structuredTasksFile = flags.tasksFile as string;

	const port = parseInt((flags.port as string) || "3456", 10);

	const server = Bun.serve({
		port,
		fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname;
			const method = req.method;

			if (method === "OPTIONS") {
				logRequest(method, path, 204);
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
				} else if (method === "GET" && path === "/history") {
					const history = loadHistory();
					response = jsonResponse(history);
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
							response = jsonResponse({
								total: allTasks.length,
								complete,
								inProgress,
								todo,
								tasks: allTasks,
							});
						} else {
							response = jsonResponse({
								total: 0,
								complete: 0,
								inProgress: 0,
								todo: 0,
								tasks: [],
							});
						}
					} else {
						const tasksPath = getTasksPath();
						if (existsSync(tasksPath)) {
							const content = readFileSync(tasksPath, "utf-8");
							const tasks = parseTasks(content);
							const complete = tasks.filter(
								(t) => t.status === "complete",
							).length;
							const inProgress = tasks.filter(
								(t) => t.status === "in-progress",
							).length;
							const todo = tasks.filter((t) => t.status === "todo").length;
							response = jsonResponse({
								total: tasks.length,
								complete,
								inProgress,
								todo,
								tasks,
							});
						} else {
							response = jsonResponse({
								total: 0,
								complete: 0,
								inProgress: 0,
								todo: 0,
								tasks: [],
							});
						}
					}
				} else if (method === "POST" && path === "/start") {
					return (async () => {
						try {
							const body = await req.json();
							const promptFile = body.promptFile as string | undefined;
							const promptText = body.prompt as string | undefined;
							const tasksFile = body.tasksFile as string | undefined;
							const milestone = body.milestone as string | undefined;

							// Check if there's already an active loop
							const existingState = loadState();
							if (existingState?.active) {
								const resp = jsonResponse(
									{ success: false, error: "A loop is already active" },
									400,
								);
								logRequest(method, path, 400);
								return resp;
							}

							// Set tasks file if provided
							if (tasksFile) {
								structuredTasksFile = tasksFile;
							}

							// Build the prompt
							let prompt = "";
							if (promptFile) {
								const promptPath = join(workspaceRoot, promptFile);
								if (!existsSync(promptPath)) {
									const resp = jsonResponse(
										{
											success: false,
											error: `Prompt file not found: ${promptFile}`,
										},
										400,
									);
									logRequest(method, path, 400);
									return resp;
								}
								prompt = readFileSync(promptPath, "utf-8");
							} else if (promptText) {
								prompt = promptText;
							} else {
								const resp = jsonResponse(
									{
										success: false,
										error: "Either 'promptFile' or 'prompt' is required",
									},
									400,
								);
								logRequest(method, path, 400);
								return resp;
							}

							// Generate loop ID
							const loopId = generateLoopId();

							// Create initial state
							const newState: RalphState = {
								active: true,
								iteration: 1,
								maxIterations: 0, // unlimited
								completionPromise: "COMPLETE",
								tasksMode: !!structuredTasksFile,
								taskPromise: "READY_FOR_NEXT_TASK",
								prompt,
								startedAt: new Date().toISOString(),
								workspaceRoot,
								structuredTasksFile: structuredTasksFile || null,
								milestoneFilter: milestone || null,
								loopId,
							};

							saveState(newState);

							// Clear any existing history for new loop
							clearHistory();

							// Build the iteration prompt
							const iterationPrompt = buildPrompt(newState);

							// Get the first task if in structured tasks mode
							let task: StructuredTask | null = null;
							if (structuredTasksFile) {
								task = getNextStructuredTask(milestone || null);
							}

							const resp = jsonResponse({
								success: true,
								loopId,
								prompt: iterationPrompt,
								task: task || undefined,
								iteration: 1,
							});
							logRequest(method, path, 200);
							return resp;
						} catch (e) {
							const message =
								e instanceof Error ? e.message : "Invalid request";
							const resp = jsonResponse(
								{ success: false, error: message },
								400,
							);
							logRequest(method, path, 400);
							return resp;
						}
					})();
				} else if (method === "POST" && path === "/iteration/complete") {
					return (async () => {
						try {
							const body = await req.json();
							const filesModified = (body.filesModified as string[]) || [];
							const errors = (body.errors as string[]) || [];
							const notes = body.notes as string | undefined;
							const completionDetected = body.completionDetected as
								| boolean
								| undefined;

							const state = loadState();
							if (!state?.active) {
								const resp = jsonResponse(
									{ success: false, error: "No active loop" },
									400,
								);
								logRequest(method, path, 400);
								return resp;
							}

							// Record iteration in history
							const history = loadHistory();
							const iterationRecord: IterationHistory = {
								iteration: state.iteration,
								startedAt: state.startedAt,
								endedAt: new Date().toISOString(),
								durationMs: Date.now() - new Date(state.startedAt).getTime(),
								toolsUsed: {},
								filesModified,
								exitCode: errors.length > 0 ? 1 : 0,
								completionDetected: completionDetected ?? false,
								errors,
							};
							history.iterations.push(iterationRecord);
							history.totalDurationMs += iterationRecord.durationMs;
							saveHistory(history);

							// Determine next action
							let next: "continue" | "complete" | "stop" = "continue";
							let task: StructuredTask | null = null;
							let prompt: string | undefined;

							// Check if loop was stopped
							const currentState = loadState();
							if (!currentState?.active) {
								next = "stop";
							} else if (completionDetected) {
								// Check if all tasks are complete
								if (state.structuredTasksFile) {
									const allComplete = allStructuredTasksComplete(
										state.milestoneFilter || null,
									);
									if (allComplete) {
										next = "complete";
										state.active = false;
										saveState(state);
									} else {
										// Get next task
										task = getNextStructuredTask(state.milestoneFilter || null);
										if (!task) {
											next = "complete";
											state.active = false;
											saveState(state);
										}
									}
								} else {
									next = "complete";
									state.active = false;
									saveState(state);
								}
							} else {
								// Continue with next iteration
								task = state.structuredTasksFile
									? getNextStructuredTask(state.milestoneFilter || null)
									: null;
							}

							// Increment iteration if continuing
							if (next === "continue") {
								state.iteration += 1;
								state.startedAt = new Date().toISOString();
								saveState(state);
								prompt = buildPrompt(state);
							}

							const resp = jsonResponse({
								success: true,
								next,
								iteration: state.iteration,
								task: task || undefined,
								prompt,
							});
							logRequest(method, path, 200);
							return resp;
						} catch (e) {
							const message =
								e instanceof Error ? e.message : "Invalid request";
							const resp = jsonResponse(
								{ success: false, error: message },
								400,
							);
							logRequest(method, path, 400);
							return resp;
						}
					})();
				} else if (method === "POST" && path === "/task/mark") {
					return (async () => {
						try {
							const body = await req.json();
							const taskId = body.taskId as string;
							const status = body.status as string;

							if (!taskId) {
								const resp = jsonResponse(
									{ success: false, error: "Missing 'taskId' field" },
									400,
								);
								logRequest(method, path, 400);
								return resp;
							}

							if (
								!status ||
								!["todo", "in-progress", "complete"].includes(status)
							) {
								const resp = jsonResponse(
									{
										success: false,
										error:
											"Invalid 'status' - must be 'todo', 'in-progress', or 'complete'",
									},
									400,
								);
								logRequest(method, path, 400);
								return resp;
							}

							const result = updateStructuredTaskStatus(
								taskId,
								status as "todo" | "in-progress" | "complete",
							);

							if (!result.success) {
								const resp = jsonResponse(
									{ success: false, error: result.error },
									400,
								);
								logRequest(method, path, 400);
								return resp;
							}

							const resp = jsonResponse({
								success: true,
								taskId,
								status,
								updatedAt: new Date().toISOString(),
							});
							logRequest(method, path, 200);
							return resp;
						} catch (e) {
							const message =
								e instanceof Error ? e.message : "Invalid request";
							const resp = jsonResponse(
								{ success: false, error: message },
								400,
							);
							logRequest(method, path, 400);
							return resp;
						}
					})();
				} else if (method === "GET" && path === "/context") {
					const context = loadContext();
					if (context) {
						// Clear context after reading
						clearContext();
						response = jsonResponse({
							hasContext: true,
							context,
							clearedAt: new Date().toISOString(),
						});
					} else {
						response = jsonResponse({
							hasContext: false,
							context: null,
						});
					}
				} else if (method === "GET" && path === "/next-task") {
					const state = loadState();
					if (!state?.active) {
						response = jsonResponse({
							hasTask: false,
							complete: true,
							reason: "No active loop",
						});
					} else if (state.structuredTasksFile) {
						const task = getNextStructuredTask(state.milestoneFilter || null);
						const allComplete = allStructuredTasksComplete(
							state.milestoneFilter || null,
						);
						if (allComplete) {
							response = jsonResponse({
								hasTask: false,
								complete: true,
								reason: "All tasks complete",
							});
						} else if (task) {
							response = jsonResponse({
								hasTask: true,
								complete: false,
								task,
							});
						} else {
							response = jsonResponse({
								hasTask: false,
								complete: false,
								reason: "No available tasks (dependencies not met)",
							});
						}
					} else {
						response = jsonResponse({
							hasTask: false,
							complete: false,
							reason: "Not in structured tasks mode",
						});
					}
				} else if (method === "POST" && path === "/context") {
					return (async () => {
						try {
							const body = await req.json();
							const text = body.text as string;

							if (!text) {
								const resp = jsonResponse(
									{ success: false, error: "Missing 'text' field" },
									400,
								);
								logRequest(method, path, 400);
								return resp;
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

							const resp = jsonResponse({ success: true, action: "added" });
							logRequest(method, path, 200);
							return resp;
						} catch (e) {
							const resp = jsonResponse(
								{ success: false, error: "Invalid JSON body" },
								400,
							);
							logRequest(method, path, 400);
							return resp;
						}
					})();
				} else if (method === "POST" && path === "/stop") {
					const state = loadState();
					if (!state?.active) {
						response = jsonResponse({
							success: false,
							error: "No active loop to stop",
						});
					} else {
						state.active = false;
						saveState(state);
						response = jsonResponse({
							success: true,
							stoppedAt: new Date().toISOString(),
							iteration: state.iteration,
						});
					}
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
	});

	console.log(`🚀 Chief Wiggum server running on http://localhost:${port}`);
	console.log(`   Workspace: ${workspaceRoot}`);
	if (structuredTasksFile) {
		console.log(`   Tasks file: ${structuredTasksFile}`);
	}
	console.log(`\n   Endpoints:`);
	console.log(`   GET  /status            - Current loop state`);
	console.log(`   GET  /history           - Iteration history`);
	console.log(`   GET  /tasks             - Task list and summary`);
	console.log(`   GET  /next-task         - Get next available task`);
	console.log(`   GET  /context           - Get and clear pending context`);
	console.log(`   POST /start             - Start a new loop`);
	console.log(`   POST /iteration/complete - Record iteration result`);
	console.log(`   POST /task/mark         - Mark task status`);
	console.log(`   POST /context           - Add context`);
	console.log(`   POST /stop              - Stop active loop`);
	console.log(`\n   Press Ctrl+C to stop\n`);
}

// ============================================================================
// Help: serve
// ============================================================================

const HELP_SERVE = `
chief-wiggum serve - Start HTTP server for state management

Usage:
  chief-wiggum serve [options]

Options:
  -p, --port <port>       Port to listen on (default: 3456)
  -w, --workspace <dir>   Target different directory
  -t, --tasks-file <path> Specify structured tasks file

Endpoints:
  GET  /status            - Current loop state as JSON
  GET  /history           - Iteration history as JSON
  GET  /tasks             - Task list and summary as JSON
  GET  /next-task         - Get next available task or completion signal
  GET  /context           - Get pending context and clear it
  POST /start             - Start a new loop (body: {promptFile?, prompt?, tasksFile?, milestone?})
  POST /iteration/complete - Record iteration result (body: {filesModified, errors, notes?, completionDetected?})
  POST /task/mark         - Mark task status (body: {taskId, status})
  POST /context           - Add context (body: {"text": "..."})
  POST /stop              - Stop active loop

Examples:
  chief-wiggum serve
  chief-wiggum serve --port 8080
  chief-wiggum serve -w ~/projects/my-app -t docs/tasks.md
`;

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
			case "summary":
				console.log(HELP_SUMMARY);
				break;
			case "stop":
				console.log(HELP_STOP);
				break;
			case "serve":
				console.log(HELP_SERVE);
				break;
			default:
				console.log(HELP_MAIN);
		}
		process.exit(0);
	}

	// Route to command - default to status if no command
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
		case "summary":
			await cmdSummary(parsed.args, parsed.flags);
			break;
		case "stop":
			cmdStop(parsed.flags);
			break;
		case "serve":
			cmdServe(parsed.flags);
			break;
		default:
			cmdStatus(parsed.flags);
			break;
	}
}

main().catch((error) => {
	console.error("Fatal error:", error);
	clearState();
	process.exit(1);
});
