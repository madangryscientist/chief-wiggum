import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { type AppContext, getContextPath, getStateDir } from "../context";
import { loadState } from "../state";

export const HELP_CONTEXT = `
chief-wiggum context - Add context for the next iteration

USAGE:
    chief-wiggum context <text>
    chief-wiggum context --clear

DESCRIPTION:
    Add context that will be injected into the next iteration's prompt.
    This is useful for providing feedback or additional instructions
    while the loop is running.

OPTIONS:
    --clear                  Clear pending context
    -w, --workspace <dir>    Set workspace directory
    -h, --help               Show this help message

EXAMPLES:
    chief-wiggum context "Focus on fixing the test failures first"
    chief-wiggum context --clear
`.trim();

export function cmdContext(
	ctx: AppContext,
	args: string[],
	flags: Record<string, string | boolean>,
): void {
	if (flags.clear) {
		const contextPath = getContextPath(ctx);
		if (existsSync(contextPath)) {
			unlinkSync(contextPath);
			console.log(`Context cleared`);
		} else {
			console.log(`No pending context to clear`);
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

	const stateDir = getStateDir(ctx);
	if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

	const timestamp = new Date().toISOString();
	const newEntry = `\n## Context added at ${timestamp}\n${contextText}\n`;

	const contextPath = getContextPath(ctx);
	if (existsSync(contextPath)) {
		const existing = readFileSync(contextPath, "utf-8");
		writeFileSync(contextPath, existing + newEntry);
	} else {
		writeFileSync(contextPath, `# Ralph Loop Context\n${newEntry}`);
	}

	console.log(`Context added for next iteration`);

	const state = loadState(ctx);
	if (state?.active) {
		console.log(`   Will be picked up in iteration ${state.iteration + 1}`);
	}
}
