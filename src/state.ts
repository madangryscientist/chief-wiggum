import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import type { AgentType } from "./agents";
import {
	type AppContext,
	getContextPath,
	getHistoryPath,
	getStateDir,
	getStatePath,
} from "./context";

export interface IterationHistory {
	iteration: number;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	toolsUsed: Record<string, number>;
	filesModified: string[];
	exitCode: number;
	completionDetected: boolean;
	errors: string[];
}

export interface RalphHistory {
	iterations: IterationHistory[];
	totalDurationMs: number;
	struggleIndicators: {
		repeatedErrors: Record<string, number>;
		noProgressIterations: number;
		shortIterations: number;
	};
}

export interface RalphState {
	active: boolean;
	iteration: number;
	maxIterations: number;
	completionPromise: string;
	tasksMode: boolean;
	taskPromise: string;
	prompt: string;
	startedAt: string;
	model: string;
	agent: AgentType;
	workspaceRoot?: string;
	structuredTasksFile?: string | null;
	milestoneFilter?: string | null;
	logFile?: string | null;
	loopId?: string | null;
}

export function loadState(ctx: AppContext): RalphState | null {
	const path = getStatePath(ctx);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

export function saveState(ctx: AppContext, state: RalphState): void {
	const dir = getStateDir(ctx);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(getStatePath(ctx), JSON.stringify(state, null, 2));
}

export function clearState(ctx: AppContext): void {
	const path = getStatePath(ctx);
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {}
	}
}

export function loadHistory(ctx: AppContext): RalphHistory {
	const path = getHistoryPath(ctx);
	if (!existsSync(path)) {
		return {
			iterations: [],
			totalDurationMs: 0,
			struggleIndicators: {
				repeatedErrors: {},
				noProgressIterations: 0,
				shortIterations: 0,
			},
		};
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {
			iterations: [],
			totalDurationMs: 0,
			struggleIndicators: {
				repeatedErrors: {},
				noProgressIterations: 0,
				shortIterations: 0,
			},
		};
	}
}

export function saveHistory(ctx: AppContext, history: RalphHistory): void {
	const dir = getStateDir(ctx);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(getHistoryPath(ctx), JSON.stringify(history, null, 2));
}

export function clearHistory(ctx: AppContext): void {
	const path = getHistoryPath(ctx);
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {}
	}
}

export function loadContext(ctx: AppContext): string | null {
	const path = getContextPath(ctx);
	if (!existsSync(path)) return null;
	try {
		const content = readFileSync(path, "utf-8").trim();
		return content || null;
	} catch {
		return null;
	}
}

export function clearContext(ctx: AppContext): void {
	const path = getContextPath(ctx);
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {}
	}
}
