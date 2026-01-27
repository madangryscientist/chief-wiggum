import { join } from "node:path";

export interface AppContext {
	workspaceRoot: string;
	structuredTasksFile: string | null;
	milestoneFilter: string | null;
	logFilePath: string | null;
}

export function createContext(overrides?: Partial<AppContext>): AppContext {
	return {
		workspaceRoot: process.cwd(),
		structuredTasksFile: null,
		milestoneFilter: null,
		logFilePath: null,
		...overrides,
	};
}

export function getStateDir(ctx: AppContext): string {
	return join(ctx.workspaceRoot, ".ralph");
}

export function getStatePath(ctx: AppContext): string {
	return join(getStateDir(ctx), "ralph-loop.state.json");
}

export function getContextPath(ctx: AppContext): string {
	return join(getStateDir(ctx), "ralph-context.md");
}

export function getHistoryPath(ctx: AppContext): string {
	return join(getStateDir(ctx), "ralph-history.json");
}

export function getTasksPath(ctx: AppContext): string {
	return join(getStateDir(ctx), "ralph-tasks.md");
}

export function getSuggestedTasksPath(ctx: AppContext): string {
	return join(getStateDir(ctx), "suggested-tasks.md");
}

export function getLogDir(ctx: AppContext): string {
	return join(getStateDir(ctx), "logs");
}

export function getAssistContextPath(ctx: AppContext): string {
	return join(getStateDir(ctx), "assist-context.md");
}
