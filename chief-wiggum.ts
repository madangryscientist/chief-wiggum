#!/usr/bin/env bun

/**
 * Chief Wiggum - Ralph Loop
 *
 * An iterative AI development loop manager that runs AI coding assistants
 * (opencode, claude-code, codex) in a loop until a task is completed.
 */

import { parseArgs } from "./src/cli";
import {
	cmdAssist,
	cmdContext,
	cmdRun,
	cmdStatus,
	cmdTasks,
	HELP_ASSIST,
	HELP_CONTEXT,
	HELP_RUN,
	HELP_STATUS,
	HELP_TASKS,
} from "./src/commands";
import { createContext } from "./src/context";
import { VERSION } from "./src/server";
import { clearState } from "./src/state";

const HELP_MAIN = `
chief-wiggum v${VERSION} - Ralph Loop Manager

USAGE:
    chief-wiggum <COMMAND> [OPTIONS]

COMMANDS:
    run        Start an iterative development loop
    status     Show current loop status
    context    Add context for the next iteration
    tasks      Manage task list
    assist     Open interactive assistant with loop context

GLOBAL OPTIONS:
    -V, --version    Show version
    -h, --help       Show help

EXAMPLES:
    chief-wiggum run "Fix all TypeScript errors"
    chief-wiggum run -f prompt.md -t docs/tasks.md -M M1
    chief-wiggum status
    chief-wiggum context "Focus on the login bug first"
    chief-wiggum tasks
    chief-wiggum assist

For command-specific help:
    chief-wiggum <COMMAND> --help
`.trim();

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2));

	// Create default context
	let ctx = createContext();

	// Apply workspace flag if present
	if (parsed.flags.workspace) {
		ctx = { ...ctx, workspaceRoot: parsed.flags.workspace as string };
	}

	// Apply tasks file flag if present
	if (parsed.flags.tasksFile) {
		ctx = { ...ctx, structuredTasksFile: parsed.flags.tasksFile as string };
	}

	// Apply milestone flag if present
	if (parsed.flags.milestone) {
		ctx = { ...ctx, milestoneFilter: parsed.flags.milestone as string };
	}

	// Handle global flags
	if (parsed.flags.version) {
		console.log(`chief-wiggum ${VERSION}`);
		process.exit(0);
	}

	if (parsed.flags.help) {
		switch (parsed.command) {
			case "run":
				console.log(HELP_RUN);
				break;
			case "status":
				console.log(HELP_STATUS);
				break;
			case "context":
				console.log(HELP_CONTEXT);
				break;
			case "tasks":
				console.log(HELP_TASKS);
				break;
			case "assist":
				console.log(HELP_ASSIST);
				break;
			default:
				console.log(HELP_MAIN);
		}
		process.exit(0);
	}

	// Default to run command if args/flags suggest it
	if (!parsed.command) {
		parsed.command = "run";
	}

	// Route to command
	switch (parsed.command) {
		case "status":
			cmdStatus(ctx);
			break;
		case "context":
			cmdContext(ctx, parsed.args, parsed.flags);
			break;
		case "tasks":
			cmdTasks(ctx, parsed.args);
			break;
		case "assist":
			await cmdAssist(ctx);
			break;
		default:
			await cmdRun(ctx, parsed.args, parsed.flags);
			break;
	}
}

main().catch((error) => {
	console.error("Fatal error:", error);
	clearState(createContext());
	process.exit(1);
});
