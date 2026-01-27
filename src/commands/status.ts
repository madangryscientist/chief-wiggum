import { AGENTS } from "../agents";
import type { AppContext } from "../context";
import { loadContext, loadHistory, loadState } from "../state";
import { formatDurationLong } from "../utils";

export const HELP_STATUS = `
chief-wiggum status - Show current loop status

USAGE:
    chief-wiggum status [OPTIONS]

OPTIONS:
    -w, --workspace <dir>    Set workspace directory
    -h, --help               Show this help message
`.trim();

export function cmdStatus(ctx: AppContext): void {
	const state = loadState(ctx);
	const history = loadHistory(ctx);
	const context = loadContext(ctx);

	console.log(`
+------------------------------------------------------------------+
|                  Chief Wiggum - Ralph Loop Status                |
+------------------------------------------------------------------+
`);

	if (state?.active) {
		const elapsed = Date.now() - new Date(state.startedAt).getTime();
		console.log(`ACTIVE LOOP`);
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
		console.log(`No active loop`);
	}

	if (context) {
		console.log(`\nPENDING CONTEXT:`);
		console.log(`   ${context.split("\n").join("\n   ")}`);
	}

	if (history.iterations.length > 0) {
		console.log(`\nHISTORY (${history.iterations.length} iterations)`);
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
				? "OK"
				: iter.exitCode !== 0
					? "ERR"
					: "...";
			console.log(
				`   ${status} #${iter.iteration}: ${formatDurationLong(iter.durationMs)} | ${tools || "no tools"}`,
			);
		}
	}

	console.log("");
}
