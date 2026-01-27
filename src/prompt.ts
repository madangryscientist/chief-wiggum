import type { AGENTS, AgentConfig } from "./agents";
import type { AppContext } from "./context";
import type { RalphState } from "./state";
import { loadContext, loadHistory, loadState } from "./state";
import {
	allStructuredTasksComplete,
	getNextStructuredTask,
	getStructuredTasksSummary,
	loadStructuredTasks,
	type StructuredTask,
} from "./tasks";
import { formatDurationLong } from "./utils";

export function buildPrompt(
	ctx: AppContext,
	state: RalphState,
	_agent: AgentConfig,
): string {
	const context = loadContext(ctx);
	const contextSection = context
		? `
## Additional Context (added by user mid-loop)

${context}

---
`
		: "";

	if (state.structuredTasksFile) {
		const summary = getStructuredTasksSummary(ctx);
		const nextTask = getNextStructuredTask(ctx);
		const allComplete = allStructuredTasksComplete(ctx);

		const data = loadStructuredTasks(ctx);
		let tasks: StructuredTask[] = [];
		if (data) {
			if (ctx.milestoneFilter) {
				tasks = data.milestones.get(ctx.milestoneFilter) || [];
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
## STRUCTURED TASKS MODE: ${ctx.milestoneFilter ? `Milestone ${ctx.milestoneFilter}` : "All Tasks"}

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
- ONLY output <promise>${state.completionPromise}</promise> when ALL tasks for milestone ${ctx.milestoneFilter || "ALL"} are complete
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

export function buildAssistContext(
	ctx: AppContext,
	agents: typeof AGENTS,
): string {
	const state = loadState(ctx);
	const history = loadHistory(ctx);
	const context = loadContext(ctx);
	const tasksData = loadStructuredTasks(ctx);
	const tasksFile = ctx.structuredTasksFile || "docs/tasks.md";

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
		const summary = getStructuredTasksSummary(ctx);
		const nextTask = getNextStructuredTask(ctx);

		md += `### Progress

`;
		if (ctx.milestoneFilter) {
			md += `Milestone: **${ctx.milestoneFilter}**\n`;
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
- **Agent**: ${state.agent ? (agents[state.agent]?.configName ?? state.agent) : "OpenCode"}
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
