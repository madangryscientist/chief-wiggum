import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "./context";

export interface StructuredTask {
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

export interface ParsedTasksFile {
	milestones: Map<string, StructuredTask[]>;
	allTasks: Map<string, StructuredTask>;
}

export interface Task {
	text: string;
	status: "todo" | "in-progress" | "complete";
	subtasks: Task[];
	originalLine: string;
}

export function parseTasks(content: string): Task[] {
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

export function parseStructuredTasks(content: string): ParsedTasksFile {
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

export function loadStructuredTasks(ctx: AppContext): ParsedTasksFile | null {
	if (!ctx.structuredTasksFile) return null;
	const fullPath = join(ctx.workspaceRoot, ctx.structuredTasksFile);
	if (!existsSync(fullPath)) return null;
	try {
		return parseStructuredTasks(readFileSync(fullPath, "utf-8"));
	} catch {
		return null;
	}
}

export function getNextStructuredTask(ctx: AppContext): StructuredTask | null {
	const data = loadStructuredTasks(ctx);
	if (!data) return null;

	let tasks: StructuredTask[];
	if (ctx.milestoneFilter) {
		tasks = data.milestones.get(ctx.milestoneFilter) || [];
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

export function allStructuredTasksComplete(ctx: AppContext): boolean {
	const data = loadStructuredTasks(ctx);
	if (!data) return false;

	let tasks: StructuredTask[];
	if (ctx.milestoneFilter) {
		tasks = data.milestones.get(ctx.milestoneFilter) || [];
	} else {
		tasks = Array.from(data.allTasks.values());
	}

	return tasks.length > 0 && tasks.every((t) => t.status === "complete");
}

export function getStructuredTasksSummary(ctx: AppContext): {
	pending: number;
	inProgress: number;
	completed: number;
	total: number;
} {
	const data = loadStructuredTasks(ctx);
	if (!data) return { pending: 0, inProgress: 0, completed: 0, total: 0 };

	let tasks: StructuredTask[];
	if (ctx.milestoneFilter) {
		tasks = data.milestones.get(ctx.milestoneFilter) || [];
	} else {
		tasks = Array.from(data.allTasks.values());
	}

	const pending = tasks.filter((t) => t.status === "todo").length;
	const inProgress = tasks.filter((t) => t.status === "in-progress").length;
	const completed = tasks.filter((t) => t.status === "complete").length;
	return { pending, inProgress, completed, total: tasks.length };
}
