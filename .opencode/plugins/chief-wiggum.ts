import { tool } from "@opencode-ai/plugin";

const DEFAULT_SERVER_URL = "http://localhost:3456";

function getServerUrl(): string {
	return process.env.CHIEF_WIGGUM_SERVER_URL || DEFAULT_SERVER_URL;
}

async function fetchJson<T>(
	path: string,
	options?: RequestInit,
): Promise<{ data?: T; error?: string }> {
	const url = `${getServerUrl()}${path}`;
	try {
		const response = await fetch(url, {
			...options,
			headers: {
				"Content-Type": "application/json",
				...options?.headers,
			},
		});

		if (!response.ok) {
			let errorBody: string | undefined;
			try {
				errorBody = await response.text();
			} catch {}
			return {
				error: `HTTP ${response.status} ${response.statusText}${errorBody ? `: ${errorBody}` : ""}`,
			};
		}

		const data = (await response.json()) as T;
		return { data };
	} catch (err) {
		const message = err instanceof Error ? err.message : "Unknown error";
		if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
			return {
				error: `Cannot connect to chief-wiggum server at ${url}. Is the server running? Start it with: chief-wiggum serve`,
			};
		}
		return { error: message };
	}
}

const status = tool({
	description:
		"Get the current status of the chief-wiggum loop, including active state, iteration count, and history",
	args: {},
	async execute() {
		const result = await fetchJson<{
			active: boolean;
			state: {
				iteration: number;
				maxIterations: number;
				loopId?: string;
				structuredTasksFile?: string;
				milestoneFilter?: string;
				startedAt: string;
			} | null;
			history: {
				iterations: unknown[];
				totalDurationMs: number;
			} | null;
			context: string | null;
		}>("/status");

		if (result.error) {
			return `Error: ${result.error}`;
		}

		return JSON.stringify(result.data, null, 2);
	},
});

const start_loop = tool({
	description:
		"Start a new chief-wiggum iteration loop. Returns the prompt for the first iteration.",
	args: {
		promptFile: tool.schema
			.string()
			.optional()
			.describe("Path to prompt file (relative to workspace)"),
		prompt: tool.schema
			.string()
			.optional()
			.describe("Direct prompt text (alternative to promptFile)"),
		tasksFile: tool.schema
			.string()
			.optional()
			.describe("Path to structured tasks file (e.g., docs/tasks.md)"),
		milestone: tool.schema
			.string()
			.optional()
			.describe("Milestone to filter tasks by (e.g., 'Milestone 1')"),
	},
	async execute(args) {
		if (!args.promptFile && !args.prompt) {
			return "Error: Either 'promptFile' or 'prompt' is required";
		}

		const result = await fetchJson<{
			success: boolean;
			error?: string;
			loopId?: string;
			prompt?: string;
			task?: {
				id: string;
				title: string;
				status: string;
			};
			iteration?: number;
		}>("/start", {
			method: "POST",
			body: JSON.stringify({
				promptFile: args.promptFile,
				prompt: args.prompt,
				tasksFile: args.tasksFile,
				milestone: args.milestone,
			}),
		});

		if (result.error) {
			return `Error: ${result.error}`;
		}

		if (!result.data?.success) {
			return `Error: ${result.data?.error || "Failed to start loop"}`;
		}

		return result.data.prompt || "Loop started but no prompt returned";
	},
});

const complete_iteration = tool({
	description:
		"Record the completion of the current iteration. Returns the next action (continue, complete, or stop) and the prompt for the next iteration if continuing.",
	args: {
		filesModified: tool.schema
			.array(tool.schema.string())
			.optional()
			.describe("List of files modified during this iteration"),
		errors: tool.schema
			.array(tool.schema.string())
			.optional()
			.describe("List of errors encountered during this iteration"),
		notes: tool.schema
			.string()
			.optional()
			.describe("Optional notes about this iteration"),
		completionDetected: tool.schema
			.boolean()
			.optional()
			.describe(
				"Whether a completion promise was detected (e.g., COMPLETE or READY_FOR_NEXT_TASK)",
			),
	},
	async execute(args) {
		const result = await fetchJson<{
			success: boolean;
			error?: string;
			next?: "continue" | "complete" | "stop";
			iteration?: number;
			task?: {
				id: string;
				title: string;
				status: string;
			};
			prompt?: string;
		}>("/iteration/complete", {
			method: "POST",
			body: JSON.stringify({
				filesModified: args.filesModified || [],
				errors: args.errors || [],
				notes: args.notes,
				completionDetected: args.completionDetected,
			}),
		});

		if (result.error) {
			return `Error: ${result.error}`;
		}

		if (!result.data?.success) {
			return `Error: ${result.data?.error || "Failed to complete iteration"}`;
		}

		const data = result.data;

		if (data.next === "complete") {
			return "LOOP_COMPLETE: All tasks have been completed. The loop has ended.";
		}

		if (data.next === "stop") {
			return "LOOP_STOPPED: The loop was stopped. No further iterations will occur.";
		}

		if (data.next === "continue" && data.prompt) {
			return data.prompt;
		}

		return JSON.stringify(data, null, 2);
	},
});

const next_task = tool({
	description:
		"Get the next available task from the task list. Returns the task details or indicates if all tasks are complete.",
	args: {},
	async execute() {
		const result = await fetchJson<{
			hasTask: boolean;
			complete: boolean;
			reason?: string;
			task?: {
				id: string;
				title: string;
				milestone: string | null;
				status: string;
				depends: string[];
				verify: string | null;
			};
		}>("/next-task");

		if (result.error) {
			return `Error: ${result.error}`;
		}

		const data = result.data;

		if (data?.complete) {
			return `ALL_TASKS_COMPLETE: ${data.reason || "All tasks have been completed"}`;
		}

		if (!data?.hasTask) {
			return `NO_TASK_AVAILABLE: ${data?.reason || "No task available"}`;
		}

		if (data?.task) {
			const task = data.task;
			let response = `NEXT_TASK:\n`;
			response += `  ID: ${task.id}\n`;
			response += `  Title: ${task.title}\n`;
			response += `  Status: ${task.status}\n`;
			if (task.milestone) response += `  Milestone: ${task.milestone}\n`;
			if (task.depends.length > 0)
				response += `  Dependencies: ${task.depends.join(", ")}\n`;
			if (task.verify) response += `  Verify: ${task.verify}\n`;
			return response;
		}

		return JSON.stringify(data, null, 2);
	},
});

const get_context = tool({
	description:
		"Get any pending context that was injected into the loop. The context is cleared after being retrieved.",
	args: {},
	async execute() {
		const result = await fetchJson<{
			hasContext: boolean;
			context: string | null;
			clearedAt?: string;
		}>("/context");

		if (result.error) {
			return `Error: ${result.error}`;
		}

		if (!result.data?.hasContext) {
			return "NO_CONTEXT: No pending context available";
		}

		return `CONTEXT_RECEIVED:\n${result.data.context}`;
	},
});

const mark_task = tool({
	description:
		"Mark a task's status in the structured tasks file. Use this to mark tasks as in-progress, complete, failed, or todo.",
	args: {
		taskId: tool.schema.string().describe("The ID of the task to mark"),
		status: tool.schema
			.enum(["todo", "in-progress", "complete", "failed"])
			.describe("The new status for the task"),
	},
	async execute(args) {
		const result = await fetchJson<{
			success: boolean;
			error?: string;
			taskId?: string;
			status?: string;
			updatedAt?: string;
		}>("/task/mark", {
			method: "POST",
			body: JSON.stringify({
				taskId: args.taskId,
				status: args.status,
			}),
		});

		if (result.error) {
			return `Error: ${result.error}`;
		}

		if (!result.data?.success) {
			return `Error: ${result.data?.error || "Failed to mark task"}`;
		}

		return `Task ${args.taskId} marked as ${args.status}`;
	},
});

const stop = tool({
	description:
		"Stop the current chief-wiggum loop. The loop will end after the current iteration.",
	args: {},
	async execute() {
		const result = await fetchJson<{
			success: boolean;
			error?: string;
			stoppedAt?: string;
			iteration?: number;
		}>("/stop", {
			method: "POST",
		});

		if (result.error) {
			return `Error: ${result.error}`;
		}

		if (!result.data?.success) {
			return `Error: ${result.data?.error || "Failed to stop loop"}`;
		}

		return `Loop stopped at iteration ${result.data.iteration}`;
	},
});

const summary = tool({
	description:
		"Get raw log content from current chief-wiggum logs for LLM analysis. Returns log files with an analysis prompt. Use archive_logs to move old logs to archive before starting fresh.",
	args: {},
	async execute() {
		const result = await fetchJson<{
			files: string[];
			fileCount: number;
			content: string;
			totalBytes: number;
			configFiles?: {
				promptFile: string | null;
				tasksFile: string | null;
			};
			error?: string;
		}>("/logs/raw");

		if (result.error) {
			return `Error: ${result.error}`;
		}

		if (result.data?.error) {
			return `Error: ${result.data.error}`;
		}

		if (!result.data?.content || result.data.fileCount === 0) {
			return "No log files found. Run some iterations first, or check if logs are in the archive.";
		}

		const promptFile = result.data.configFiles?.promptFile || "docs/prompt.md";
		const tasksFile = result.data.configFiles?.tasksFile || "docs/tasks.md";

		const analysisPrompt = `Analyze these chief-wiggum iteration logs and provide:

1. **Summary of Work**
   - Tasks completed (look for "Task X marked as complete")
   - Files modified
   - Key accomplishments

2. **Errors & Issues**
   - List unique errors with frequency
   - Which iteration each error first appeared

3. **Inefficiency Patterns** (MOST IMPORTANT)
   - Same file read multiple times across iterations
   - Same test/command run repeatedly
   - Repeated failed attempts at the same thing
   - Unnecessary re-exploration of code already understood

4. **Actionable Suggestions**
   - Specific text to add to the prompt file to prevent repeated work
   - Example: "After running tests, cache the results and don't re-run unless files change"

5. **Stats**
   - Number of iterations
   - Approximate time per iteration
   - Tool usage breakdown (which tools used most)

## Configuration Files

After analysis, if the user asks you to update the config files, these are the key files:

- **\`${promptFile}\`** - The main prompt file. Add instructions here to prevent inefficiencies found in logs.
- **\`${tasksFile}\`** - Structured task list with milestones.

When suggesting prompt improvements, provide the exact text to add to \`${promptFile}\`.

<logs file_count="${result.data.fileCount}" total_bytes="${result.data.totalBytes}">
${result.data.content}
</logs>`;

		return analysisPrompt;
	},
});

const logs = tool({
	description:
		"List or read ARCHIVED log files from logs/archive/. Use without arguments to list available archived files, or specify a file name to read its contents.",
	args: {
		file: tool.schema
			.string()
			.optional()
			.describe(
				"Specific archived log file name to read (omit to list available files)",
			),
	},
	async execute(args) {
		const path = args.file
			? `/logs?file=${encodeURIComponent(args.file)}`
			: "/logs";

		const result = await fetchJson<{
			archiveDir?: string;
			archivedFiles?: string[];
			count?: number;
			message?: string;
			file?: string;
			path?: string;
			content?: string;
			error?: string;
		}>(path);

		if (result.error) {
			return `Error: ${result.error}`;
		}

		if (result.data?.error) {
			return `Error: ${result.data.error}`;
		}

		// If listing files
		if (result.data?.archivedFiles !== undefined) {
			if (result.data.archivedFiles.length === 0) {
				return (
					result.data.message ||
					"No archived log files found. Use archive_logs to archive current logs."
				);
			}
			let output = `## Archived Log Files (${result.data.count})\n\n`;
			output += `Archive directory: ${result.data.archiveDir}\n\n`;
			output += `Available archives:\n`;
			for (const file of result.data.archivedFiles) {
				output += `- ${file}\n`;
			}
			output += `\nUse logs(file: "filename.log") to read a specific file.`;
			return output;
		}

		// If reading a file
		let output = `## Archived Log: ${result.data?.file}\n\n`;
		output += result.data?.content || "No content";

		return output;
	},
});

const archive_logs = tool({
	description:
		"Move all current log files to the archive folder (logs/archive/). The currently active log file will be skipped. Use this to clean up old logs while preserving them for future reference.",
	args: {},
	async execute() {
		const result = await fetchJson<{
			archived: string[];
			skipped: string[];
			archivedCount: number;
			skippedCount: number;
			archiveDir: string;
			error?: string;
			message?: string;
		}>("/logs/archive", {
			method: "POST",
		});

		if (result.error) {
			return `Error: ${result.error}`;
		}

		if (result.data?.error) {
			return `Error: ${result.data.error}`;
		}

		if (result.data?.message) {
			return result.data.message;
		}

		let output = `## Logs Archived\n\n`;
		output += `Archived ${result.data?.archivedCount} file(s) to ${result.data?.archiveDir}\n`;

		if (result.data?.archived && result.data.archived.length > 0) {
			output += `\nArchived files:\n`;
			for (const file of result.data.archived) {
				output += `- ${file}\n`;
			}
		}

		if (result.data?.skipped && result.data.skipped.length > 0) {
			output += `\nSkipped (active or error):\n`;
			for (const file of result.data.skipped) {
				output += `- ${file}\n`;
			}
		}

		return output;
	},
});

const suggested_tasks = tool({
	description:
		"Get suggested tasks discovered during iterations. These are tasks the agent suggested via <suggest-task> tags that aren't in the main task list.",
	args: {},
	async execute() {
		const result = await fetchJson<{
			path: string;
			content: string | null;
			message?: string;
		}>("/suggested-tasks");

		if (result.error) {
			return `Error: ${result.error}`;
		}

		if (!result.data?.content) {
			return result.data?.message || "No suggested tasks found.";
		}

		return result.data.content;
	},
});

export const ChiefWiggumPlugin = async () => ({
	tool: {
		status,
		summary,
		logs,
		archive_logs,
		suggested_tasks,
		start_loop,
		complete_iteration,
		next_task,
		get_context,
		mark_task,
		stop,
	},
});
