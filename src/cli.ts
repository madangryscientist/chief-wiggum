export interface ParsedArgs {
	command: string;
	args: string[];
	flags: Record<string, string | boolean>;
}

export type FlagDef = { key: string; hasValue: boolean; default?: string };

export const FLAG_DEFS: Record<string, FlagDef> = {
	"-h": { key: "help", hasValue: false },
	"--help": { key: "help", hasValue: false },
	"-V": { key: "version", hasValue: false },
	"--version": { key: "version", hasValue: false },
	"-f": { key: "prompt", hasValue: true },
	"--prompt": { key: "prompt", hasValue: true },
	"-n": { key: "iterations", hasValue: true, default: "0" },
	"--iterations": { key: "iterations", hasValue: true, default: "0" },
	"-m": { key: "model", hasValue: true },
	"--model": { key: "model", hasValue: true },
	"-a": { key: "agent", hasValue: true },
	"--agent": { key: "agent", hasValue: true },
	"-t": { key: "tasksFile", hasValue: true },
	"--tasks-file": { key: "tasksFile", hasValue: true },
	"-M": { key: "milestone", hasValue: true },
	"--milestone": { key: "milestone", hasValue: true },
	"-w": { key: "workspace", hasValue: true },
	"--workspace": { key: "workspace", hasValue: true },
	"--repo": { key: "repo", hasValue: true },
	"-b": { key: "branch", hasValue: true },
	"--branch": { key: "branch", hasValue: true },
	"--done": { key: "done", hasValue: true },
	"--next": { key: "next", hasValue: true },
	"--timeout": { key: "timeout", hasValue: true, default: "30" },
	"--force": { key: "force", hasValue: false },
	"-v": { key: "verbose", hasValue: false },
	"--verbose": { key: "verbose", hasValue: false },
	"-q": { key: "quiet", hasValue: false },
	"--quiet": { key: "quiet", hasValue: false },
	"--no-commit": { key: "noCommit", hasValue: false },
	"-i": { key: "interactive", hasValue: false },
	"--interactive": { key: "interactive", hasValue: false },
	"--no-plugins": { key: "noPlugins", hasValue: false },
	"--log": { key: "log", hasValue: false },
	"--clear": { key: "clear", hasValue: false },
	"--json": { key: "json", hasValue: false },
	"-p": { key: "port", hasValue: true, default: "3456" },
	"--port": { key: "port", hasValue: true, default: "3456" },
	"--count": { key: "count", hasValue: true, default: "5" },
	"--lines": { key: "lines", hasValue: true, default: "1000" },
};

export const COMMANDS = [
	"run",
	"serve",
	"status",
	"context",
	"tasks",
	"logs",
	"summary",
	"stop",
	"assist",
];

export function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = { command: "", args: [], flags: {} };

	if (argv.length > 0 && COMMANDS.includes(argv[0])) {
		result.command = argv[0];
		argv = argv.slice(1);
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const def = FLAG_DEFS[arg];

		if (def) {
			result.flags[def.key] = def.hasValue
				? (argv[++i] ?? def.default ?? "")
				: true;
		} else if (arg.startsWith("-")) {
			console.error(`Unknown option: ${arg}`);
			console.error(`Run 'chief-wiggum --help' for usage`);
			process.exit(1);
		} else {
			result.args.push(arg);
		}
	}

	return result;
}
