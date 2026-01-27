import { ensureRalphConfig } from "./config";
import type { AppContext } from "./context";
import { stripAnsi } from "./utils";

export type AgentType = "opencode" | "claude-code" | "codex";

export interface AgentConfig {
	type: AgentType;
	command: string;
	buildArgs: (
		prompt: string,
		model: string,
		options?: { allowAllPermissions?: boolean },
	) => string[];
	buildEnv: (
		ctx: AppContext,
		options: {
			filterPlugins?: boolean;
			allowAllPermissions?: boolean;
		},
	) => NodeJS.ProcessEnv;
	parseToolOutput: (line: string) => string | null;
	configName: string;
}

export const AGENTS: Record<AgentType, AgentConfig> = {
	opencode: {
		type: "opencode",
		command: "opencode",
		buildArgs: (promptText, modelName) => {
			const args = ["run"];
			if (modelName) args.push("-m", modelName);
			args.push(promptText);
			return args;
		},
		buildEnv: (ctx, options) => {
			const env = { ...process.env };
			if (options.filterPlugins || options.allowAllPermissions) {
				env.OPENCODE_CONFIG = ensureRalphConfig(ctx, options);
			}
			return env;
		},
		parseToolOutput: (line) => {
			const match = stripAnsi(line).match(/^\|\s{2}([A-Za-z0-9_-]+)/);
			return match ? match[1] : null;
		},
		configName: "OpenCode",
	},
	"claude-code": {
		type: "claude-code",
		command: "claude",
		buildArgs: (promptText, modelName, options) => {
			const args = ["-p", promptText];
			if (modelName) args.push("--model", modelName);
			if (options?.allowAllPermissions)
				args.push("--dangerously-skip-permissions");
			return args;
		},
		buildEnv: () => ({ ...process.env }),
		parseToolOutput: (line) => {
			const match = stripAnsi(line).match(
				/(?:Using|Called|Tool:)\s+([A-Za-z0-9_-]+)/i,
			);
			return match ? match[1] : null;
		},
		configName: "Claude Code",
	},
	codex: {
		type: "codex",
		command: "codex",
		buildArgs: (promptText, modelName, options) => {
			const args = ["exec"];
			if (modelName) args.push("--model", modelName);
			if (options?.allowAllPermissions) args.push("--full-auto");
			args.push(promptText);
			return args;
		},
		buildEnv: () => ({ ...process.env }),
		parseToolOutput: (line) => {
			const match = stripAnsi(line).match(
				/(?:Tool:|Using|Calling|Running)\s+([A-Za-z0-9_-]+)/i,
			);
			return match ? match[1] : null;
		},
		configName: "Codex",
	},
};
