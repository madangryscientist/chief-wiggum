import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AppContext, getStateDir, getTasksPath } from "../context";
import { loadStructuredTasks, parseTasks } from "../tasks";

export const HELP_TASKS = `
chief-wiggum tasks - Manage simple task list

USAGE:
    chief-wiggum tasks [SUBCOMMAND]

SUBCOMMANDS:
    list                     List all tasks (default)
    add <description>        Add a new task
    rm <index>               Remove a task by index

OPTIONS:
    -w, --workspace <dir>    Set workspace directory
    -t, --tasks-file <path>  Path to structured tasks file
    -h, --help               Show this help message

EXAMPLES:
    chief-wiggum tasks
    chief-wiggum tasks add "Fix the login bug"
    chief-wiggum tasks rm 3
`.trim();

export function cmdTasks(ctx: AppContext, args: string[]): void {
	const subcommand = args[0] || "list";

	if (subcommand === "add") {
		const desc = args.slice(1).join(" ");
		if (!desc) {
			console.error("Error: No task description");
			console.error("Usage: chief-wiggum tasks add <description>");
			process.exit(1);
		}

		const tasksPath = getTasksPath(ctx);
		const stateDir = getStateDir(ctx);
		if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

		let content = "";
		if (existsSync(tasksPath)) {
			content = readFileSync(tasksPath, "utf-8");
		} else {
			content = "# Ralph Tasks\n\n";
		}

		writeFileSync(tasksPath, `${content.trimEnd()}\n- [ ] ${desc}\n`);
		console.log(`Task added: "${desc}"`);
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
		const tasksPath = getTasksPath(ctx);

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
				}
				inRemovedTask = false;
			}
			if (inRemovedTask && line.match(/^\s+/) && line.trim() !== "") continue;
			newLines.push(line);
		}

		writeFileSync(tasksPath, newLines.join("\n"));
		console.log(`Removed task ${taskIndex}`);
		return;
	}

	// Default: list tasks
	if (ctx.structuredTasksFile) {
		const data = loadStructuredTasks(ctx);
		if (data) {
			console.log("Structured Tasks:\n");
			for (const [milestone, tasks] of data.milestones) {
				const complete = tasks.filter((t) => t.status === "complete").length;
				console.log(`## ${milestone} (${complete}/${tasks.length})`);
				for (const task of tasks) {
					const icon =
						task.status === "complete"
							? "[x]"
							: task.status === "in-progress"
								? "[/]"
								: "[ ]";
					console.log(`   ${icon} ${task.id}: ${task.title}`);
				}
				console.log("");
			}
			return;
		}
	}

	const tasksPath = getTasksPath(ctx);
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
				? "[x]"
				: task.status === "in-progress"
					? "[/]"
					: "[ ]";
		console.log(`${i + 1}. ${icon} ${task.text}`);
		for (const sub of task.subtasks) {
			const subIcon =
				sub.status === "complete"
					? "[x]"
					: sub.status === "in-progress"
						? "[/]"
						: "[ ]";
			console.log(`      ${subIcon} ${sub.text}`);
		}
	}
}
