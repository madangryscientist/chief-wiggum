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

const loop_status = tool({
	description:
		"Get the current status of the chief-wiggum loop. Use this to check if a loop is active and its progress.",
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
				prompt: string;
			} | null;
			history: {
				iterations: Array<{
					iteration: number;
					durationMs: number;
					completionDetected: boolean;
					errors: string[];
				}>;
				totalDurationMs: number;
			} | null;
			context: string | null;
		}>("/status");

		if (result.error) {
			return `Error: ${result.error}`;
		}

		const data = result.data;
		if (!data) return "No data returned";

		let output = "";

		if (data.active && data.state) {
			const elapsed = Date.now() - new Date(data.state.startedAt).getTime();
			const minutes = Math.floor(elapsed / 60000);
			const seconds = Math.floor((elapsed % 60000) / 1000);
			output += `LOOP ACTIVE\n`;
			output += `  Loop ID: ${data.state.loopId || "unknown"}\n`;
			output += `  Iteration: ${data.state.iteration}${data.state.maxIterations > 0 ? ` / ${data.state.maxIterations}` : " (unlimited)"}\n`;
			output += `  Elapsed: ${minutes}m ${seconds}s\n`;
			if (data.state.structuredTasksFile) {
				output += `  Tasks file: ${data.state.structuredTasksFile}\n`;
			}
			if (data.state.milestoneFilter) {
				output += `  Milestone: ${data.state.milestoneFilter}\n`;
			}
		} else {
			output += `NO ACTIVE LOOP\n`;
		}

		if (data.history && data.history.iterations.length > 0) {
			const totalMs = data.history.totalDurationMs;
			const minutes = Math.floor(totalMs / 60000);
			const seconds = Math.floor((totalMs % 60000) / 1000);
			output += `\nHISTORY\n`;
			output += `  Total iterations: ${data.history.iterations.length}\n`;
			output += `  Total time: ${minutes}m ${seconds}s\n`;

			const recent = data.history.iterations.slice(-3);
			if (recent.length > 0) {
				output += `  Recent:\n`;
				for (const iter of recent) {
					const status = iter.completionDetected
						? "completed"
						: iter.errors.length > 0
							? "errors"
							: "ok";
					output += `    #${iter.iteration}: ${Math.round(iter.durationMs / 1000)}s (${status})\n`;
				}
			}
		}

		if (data.context) {
			output += `\nPENDING CONTEXT: Yes (${data.context.length} chars)\n`;
		}

		return output;
	},
});

const inject_context = tool({
	description:
		"Inject context into the running loop. The subagent will receive this on its next get_context call.",
	args: {
		text: tool.schema.string().describe("Context text to inject into the loop"),
	},
	async execute(args) {
		const result = await fetchJson<{
			success: boolean;
			error?: string;
		}>("/context", {
			method: "POST",
			body: JSON.stringify({ text: args.text }),
		});

		if (result.error) {
			return `Error: ${result.error}`;
		}

		if (!result.data?.success) {
			return `Error: ${result.data?.error || "Failed to inject context"}`;
		}

		return `Context injected. The subagent will receive it on next get_context call.`;
	},
});

const stop_loop = tool({
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

const list_tasks = tool({
	description:
		"List all tasks from the structured tasks file with their current status.",
	args: {},
	async execute() {
		const result = await fetchJson<{
			total: number;
			complete: number;
			inProgress: number;
			todo: number;
			failed: number;
			tasks: Array<{
				id: string;
				title: string;
				milestone: string | null;
				status: "todo" | "in-progress" | "complete" | "failed";
				depends: string[];
				failedReason: string | null;
			}>;
		}>("/tasks");

		if (result.error) {
			return `Error: ${result.error}`;
		}

		const data = result.data;
		if (!data) return "No data returned";

		let output = `TASKS: ${data.complete}/${data.total} complete`;
		if (data.inProgress > 0) output += `, ${data.inProgress} in progress`;
		if (data.todo > 0) output += `, ${data.todo} pending`;
		if (data.failed > 0) output += `, ${data.failed} failed`;
		output += "\n\n";

		const statusIcons: Record<string, string> = {
			complete: "[x]",
			failed: "[!]",
			"in-progress": "[/]",
			todo: "[ ]",
		};

		for (const task of data.tasks) {
			const icon = statusIcons[task.status] || "[ ]";
			output += `${icon} ${task.id}: ${task.title}`;
			if (task.milestone) output += ` (${task.milestone})`;
			if (task.status === "failed" && task.failedReason)
				output += ` — ${task.failedReason}`;
			output += "\n";
		}

		return output;
	},
});

const summarize_loop = tool({
	description:
		"Get a summary of the loop history including iterations, time spent, and any errors.",
	args: {},
	async execute() {
		const result = await fetchJson<{
			iterations: Array<{
				iteration: number;
				startedAt: string;
				endedAt: string;
				durationMs: number;
				toolsUsed: Record<string, number>;
				filesModified: string[];
				exitCode: number;
				completionDetected: boolean;
				errors: string[];
			}>;
			totalDurationMs: number;
			struggleIndicators: {
				repeatedErrors: Record<string, number>;
				noProgressIterations: number;
				shortIterations: number;
			};
		}>("/history");

		if (result.error) {
			return `Error: ${result.error}`;
		}

		const data = result.data;
		if (!data) return "No data returned";

		if (data.iterations.length === 0) {
			return "No iteration history available.";
		}

		const totalMs = data.totalDurationMs;
		const minutes = Math.floor(totalMs / 60000);
		const seconds = Math.floor((totalMs % 60000) / 1000);

		let output = `LOOP SUMMARY\n`;
		output += `  Iterations: ${data.iterations.length}\n`;
		output += `  Total time: ${minutes}m ${seconds}s\n`;
		output += `  Avg per iteration: ${Math.round(totalMs / data.iterations.length / 1000)}s\n`;

		// Count completions and errors
		const completions = data.iterations.filter(
			(i) => i.completionDetected,
		).length;
		const withErrors = data.iterations.filter(
			(i) => i.errors.length > 0,
		).length;
		output += `  Completions detected: ${completions}\n`;
		output += `  Iterations with errors: ${withErrors}\n`;

		// Aggregate tools used
		const allTools: Record<string, number> = {};
		for (const iter of data.iterations) {
			for (const [tool, count] of Object.entries(iter.toolsUsed)) {
				allTools[tool] = (allTools[tool] || 0) + count;
			}
		}
		const topTools = Object.entries(allTools)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5);
		if (topTools.length > 0) {
			output += `\nTOP TOOLS:\n`;
			for (const [tool, count] of topTools) {
				output += `  ${tool}: ${count}\n`;
			}
		}

		// Aggregate files modified
		const allFiles = new Set<string>();
		for (const iter of data.iterations) {
			for (const file of iter.filesModified) {
				allFiles.add(file);
			}
		}
		if (allFiles.size > 0) {
			output += `\nFILES MODIFIED: ${allFiles.size}\n`;
			for (const file of Array.from(allFiles).slice(0, 10)) {
				output += `  ${file}\n`;
			}
			if (allFiles.size > 10) {
				output += `  ... and ${allFiles.size - 10} more\n`;
			}
		}

		// Struggle indicators
		const struggles = data.struggleIndicators;
		if (
			struggles.noProgressIterations > 0 ||
			struggles.shortIterations > 0 ||
			Object.keys(struggles.repeatedErrors).length > 0
		) {
			output += `\nSTRUGGLE INDICATORS:\n`;
			if (struggles.noProgressIterations > 0) {
				output += `  No-progress iterations: ${struggles.noProgressIterations}\n`;
			}
			if (struggles.shortIterations > 0) {
				output += `  Short iterations: ${struggles.shortIterations}\n`;
			}
			const repeatedErrs = Object.entries(struggles.repeatedErrors);
			if (repeatedErrs.length > 0) {
				output += `  Repeated errors:\n`;
				for (const [err, count] of repeatedErrs.slice(0, 3)) {
					output += `    "${err.slice(0, 50)}...": ${count}x\n`;
				}
			}
		}

		return output;
	},
});

const health_check = tool({
	description: "Check if the chief-wiggum server is running and healthy.",
	args: {},
	async execute() {
		const result = await fetchJson<{
			status: string;
			version: string;
			uptime: number;
		}>("/health");

		if (result.error) {
			return `Server not available: ${result.error}`;
		}

		const data = result.data;
		if (!data) return "No data returned";

		const uptimeMin = Math.floor(data.uptime / 60);
		const uptimeSec = Math.round(data.uptime % 60);

		return `Server OK\n  Version: ${data.version}\n  Uptime: ${uptimeMin}m ${uptimeSec}s`;
	},
});

export const ChiefWiggumObserverPlugin = async () => ({
	tool: {
		loop_status,
		inject_context,
		stop_loop,
		list_tasks,
		summarize_loop,
		health_check,
	},
});
