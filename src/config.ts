import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppContext, getStateDir } from "./context";

function loadPluginsFromConfig(configPath: string): string[] {
	if (!existsSync(configPath)) return [];
	try {
		const raw = readFileSync(configPath, "utf-8");
		const withoutBlock = raw.replace(/\/\*[\s\S]*?\*\//g, "");
		const withoutLine = withoutBlock.replace(/^\s*\/\/.*$/gm, "");
		const parsed = JSON.parse(withoutLine);
		const plugins = parsed?.plugin;
		return Array.isArray(plugins)
			? plugins.filter((p) => typeof p === "string")
			: [];
	} catch {
		return [];
	}
}

export function ensureRalphConfig(
	ctx: AppContext,
	options: {
		filterPlugins?: boolean;
		allowAllPermissions?: boolean;
	},
): string {
	const stateDir = getStateDir(ctx);
	if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

	const configPath = join(stateDir, "ralph-opencode.config.json");
	const userConfigPath = join(
		process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
		"opencode",
		"opencode.json",
	);
	const projectConfigPath = join(ctx.workspaceRoot, ".ralph", "opencode.json");
	const legacyProjectConfigPath = join(
		ctx.workspaceRoot,
		".opencode",
		"opencode.json",
	);

	const config: Record<string, unknown> = {
		$schema: "https://opencode.ai/config.json",
	};

	if (options.filterPlugins) {
		const plugins = [
			...loadPluginsFromConfig(userConfigPath),
			...loadPluginsFromConfig(projectConfigPath),
			...loadPluginsFromConfig(legacyProjectConfigPath),
		];
		config.plugin = Array.from(new Set(plugins)).filter((p) => /auth/i.test(p));
	}

	if (options.allowAllPermissions) {
		config.permission = {
			read: "allow",
			edit: "allow",
			glob: "allow",
			grep: "allow",
			list: "allow",
			bash: "allow",
			task: "allow",
			webfetch: "allow",
			websearch: "allow",
			codesearch: "allow",
			todowrite: "allow",
			todoread: "allow",
			question: "allow",
			lsp: "allow",
			external_directory: "allow",
		};
	}

	writeFileSync(configPath, JSON.stringify(config, null, 2));
	return configPath;
}
