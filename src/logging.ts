import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppContext, getLogDir, getSuggestedTasksPath } from "./context";

export function initLogFile(ctx: AppContext): string | null {
	if (!ctx.logFilePath) return null;

	const logDir = getLogDir(ctx);
	if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const milestone = ctx.milestoneFilter || "all";
	const logFilePath = join(logDir, `${milestone}-${timestamp}.log`);

	writeFileSync(
		logFilePath,
		`==========================================
Ralph Wiggum Session Log
==========================================
Started:      ${new Date().toLocaleString()}
Milestone:    ${ctx.milestoneFilter || "ALL"}
Working Dir:  ${ctx.workspaceRoot}
Tasks File:   ${ctx.structuredTasksFile || "N/A"}
==========================================

`,
	);

	return logFilePath;
}

export function parseSuggestedTasks(
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

export function appendSuggestedTasks(
	ctx: AppContext,
	suggestions: Array<{ task: string; milestone: string | null }>,
	iteration: number,
): void {
	if (suggestions.length === 0) return;

	const suggestedPath = getSuggestedTasksPath(ctx);
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
