import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { AGENTS } from "../agents";
import { type AppContext, getAssistContextPath, getStateDir } from "../context";
import { buildAssistContext } from "../prompt";
import { loadState } from "../state";

export const HELP_ASSIST = `
chief-wiggum assist - Open interactive assistant with loop context

USAGE:
    chief-wiggum assist [OPTIONS]

DESCRIPTION:
    Opens opencode with context about the current Ralph loop state,
    including task progress, recent iterations, and any errors.
    Useful for debugging or getting help while a loop is running.

OPTIONS:
    -w, --workspace <dir>    Set workspace directory
    -t, --tasks-file <path>  Path to structured tasks file
    -h, --help               Show this help message
`.trim();

export async function cmdAssist(ctx: AppContext): Promise<void> {
	// Default tasks file if not set
	let tasksFile = ctx.structuredTasksFile;
	if (!tasksFile) {
		const state = loadState(ctx);
		if (state?.structuredTasksFile) {
			tasksFile = state.structuredTasksFile;
		} else {
			tasksFile = "docs/tasks.md";
		}
	}

	// Load milestone filter from state if available
	let milestoneFilter = ctx.milestoneFilter;
	const state = loadState(ctx);
	if (state?.milestoneFilter) {
		milestoneFilter = state.milestoneFilter;
	}

	// Build context with updated values
	const updatedCtx: AppContext = {
		...ctx,
		structuredTasksFile: tasksFile,
		milestoneFilter,
	};

	const contextContent = buildAssistContext(updatedCtx, AGENTS);
	const stateDir = getStateDir(ctx);
	if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

	const contextPath = getAssistContextPath(ctx);
	writeFileSync(contextPath, contextContent);

	console.log(`
+------------------------------------------------------------------+
|                  Chief Wiggum - Assist Mode                      |
+------------------------------------------------------------------+

Context written to: ${contextPath}

Opening opencode...

To use the context, reference the file in your conversation:
  "Read .ralph/assist-context.md for context about the loop"

`);

	const opencodePath = Bun.which("opencode");
	if (!opencodePath) {
		console.error("Error: opencode CLI not found in PATH");
		console.log("Install opencode or ensure it's in your PATH");
		process.exit(1);
	}

	const proc = Bun.spawn(["opencode"], {
		cwd: ctx.workspaceRoot,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});

	await proc.exited;
}
