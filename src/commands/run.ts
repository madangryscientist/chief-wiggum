import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { AGENTS, type AgentType } from "../agents";
import type { AppContext } from "../context";
import {
	appendSuggestedTasks,
	initLogFile,
	parseSuggestedTasks,
} from "../logging";
import {
	captureFileSnapshot,
	extractErrors,
	formatToolSummary,
	getModifiedFilesSinceSnapshot,
	streamProcessOutput,
} from "../output";
import { buildPrompt } from "../prompt";
import { startHttpServer } from "../server";
import {
	clearContext,
	clearHistory,
	clearState,
	loadContext,
	loadState,
	type RalphHistory,
	type RalphState,
	saveHistory,
	saveState,
} from "../state";
import { getNextStructuredTask, getStructuredTasksSummary } from "../tasks";
import { escapeRegex, formatDuration, formatDurationLong } from "../utils";
import { setupWorktree } from "../worktree";

export const HELP_RUN = `
chief-wiggum run - Start an iterative development loop

USAGE:
    chief-wiggum run [OPTIONS] [PROMPT]
    chief-wiggum run -f <prompt-file> [OPTIONS]

OPTIONS:
    -f, --prompt <file>      Read prompt from file
    -m, --model <model>      Model to use (default: anthropic/claude-sonnet-4-5)
    -a, --agent <agent>      Agent to use: opencode, claude-code, codex
    -i, --iterations <n>     Max iterations (0 = unlimited)
    -t, --tasks-file <path>  Structured tasks file (enables task mode)
    -M, --milestone <id>     Filter to specific milestone
    -w, --workspace <dir>    Working directory
    -r, --repo <url>         Git repo URL (creates worktree)
    -b, --branch <name>      Branch name for worktree
    --done <promise>         Completion promise string (default: COMPLETE)
    --next <promise>         Task completion promise (default: READY_FOR_NEXT_TASK)
    --timeout <minutes>      Inactivity timeout (default: 30, 0 = disabled)
    --force                  Clear existing state and restart
    --verbose                Show full output (no tool summarization)
    --quiet                  Minimal output
    --no-commit              Don't auto-commit after iterations
    --interactive            Don't auto-approve agent actions
    --no-plugins             Disable plugins (opencode only)
    --log                    Enable logging to file
    --port <port>            HTTP server port (default: 3456)
    -h, --help               Show this help message

EXAMPLES:
    chief-wiggum run "Fix all TypeScript errors"
    chief-wiggum run -f tasks-prompt.md -t docs/tasks.md -M M1
    chief-wiggum run -f prompt.md --iterations 10 --timeout 60
`.trim();

export interface RunOptions {
	prompt: string;
	promptFile: string;
	model: string;
	agent: AgentType;
	iterations: number;
	tasksFile: string | null;
	milestone: string | null;
	workspace: string;
	repo: string | null;
	branch: string | null;
	done: string;
	next: string;
	timeout: number;
	force: boolean;
	verbose: boolean;
	quiet: boolean;
	noCommit: boolean;
	interactive: boolean;
	noPlugins: boolean;
	log: boolean;
	port: number;
}

export async function cmdRun(
	ctx: AppContext,
	args: string[],
	flags: Record<string, string | boolean>,
): Promise<void> {
	const opts: RunOptions = {
		prompt: "",
		promptFile: (flags.prompt as string) || "",
		model: (flags.model as string) || "anthropic/claude-sonnet-4-5",
		agent: ((flags.agent as string) || "opencode") as AgentType,
		iterations: parseInt((flags.iterations as string) || "0", 10) || 0,
		tasksFile: (flags.tasksFile as string) || null,
		milestone: (flags.milestone as string) || null,
		workspace: (flags.workspace as string) || process.cwd(),
		repo: (flags.repo as string) || null,
		branch: (flags.branch as string) || null,
		done: (flags.done as string) || "COMPLETE",
		next: (flags.next as string) || "READY_FOR_NEXT_TASK",
		timeout: parseInt((flags.timeout as string) || "30", 10) || 30,
		force: !!flags.force,
		verbose: !!flags.verbose,
		quiet: !!flags.quiet,
		noCommit: !!flags.noCommit,
		interactive: !!flags.interactive,
		noPlugins: !!flags.noPlugins,
		log: !!flags.log,
		port: parseInt((flags.port as string) || "3456", 10),
	};

	// Update context
	let runCtx: AppContext = {
		...ctx,
		workspaceRoot: opts.workspace,
		structuredTasksFile: opts.tasksFile,
		milestoneFilter: opts.milestone,
	};

	// Load prompt
	if (opts.promptFile) {
		if (!existsSync(opts.promptFile)) {
			console.error(`Error: Prompt file not found: ${opts.promptFile}`);
			process.exit(1);
		}
		opts.prompt = readFileSync(opts.promptFile, "utf-8");
	} else if (args.length > 0) {
		if (args.length === 1 && existsSync(args[0])) {
			opts.promptFile = args[0];
			opts.prompt = readFileSync(args[0], "utf-8");
		} else {
			opts.prompt = args.join(" ");
		}
	}

	if (!opts.prompt) {
		console.error("Error: No prompt provided");
		console.error("Usage: chief-wiggum run -f <file> [options]");
		console.error("       chief-wiggum run <prompt> [options]");
		process.exit(1);
	}

	// Handle worktree setup
	if (opts.repo) {
		if (!opts.promptFile) {
			console.error("Error: --repo requires -f <prompt-file>");
			process.exit(1);
		}
		const result = await setupWorktree(
			opts.repo,
			opts.prompt,
			opts.branch,
			opts.promptFile,
			opts.tasksFile,
		);
		runCtx = {
			...runCtx,
			workspaceRoot: result.worktreePath,
			structuredTasksFile: result.tasksFile || runCtx.structuredTasksFile,
		};
		opts.workspace = result.worktreePath;

		const newPromptPath = join(runCtx.workspaceRoot, result.promptFile);
		if (existsSync(newPromptPath)) {
			opts.prompt = readFileSync(newPromptPath, "utf-8");
		}
	}

	// Validate agent
	const agentConfig = AGENTS[opts.agent];
	if (!agentConfig) {
		console.error(`Error: Unknown agent: ${opts.agent}`);
		console.error("Available: opencode, claude-code, codex");
		process.exit(1);
	}

	const agentPath = Bun.which(agentConfig.command);
	if (!agentPath) {
		console.error(
			`Error: ${agentConfig.configName} CLI ('${agentConfig.command}') not found`,
		);
		process.exit(1);
	}

	// Check for existing state
	const existingState = loadState(runCtx);
	if (existingState?.active) {
		if (opts.force) {
			console.log(
				`Clearing stale state from iteration ${existingState.iteration}`,
			);
			clearState(runCtx);
		} else {
			console.error(
				`Error: Loop already active (iteration ${existingState.iteration})`,
			);
			console.error(`Started: ${existingState.startedAt}`);
			console.error(`Use --force to clear and restart`);
			process.exit(1);
		}
	}

	// Initialize logging
	if (opts.log) {
		runCtx = { ...runCtx, logFilePath: "auto" };
		initLogFile(runCtx);
	}

	// Print banner
	console.log(`
+------------------------------------------------------------------+
|                  Chief Wiggum - Ralph Loop                       |
|         Iterative AI Development with ${agentConfig.configName.padEnd(20)}         |
+------------------------------------------------------------------+
`);

	const promptPreview =
		opts.prompt.replace(/\s+/g, " ").substring(0, 60) +
		(opts.prompt.length > 60 ? "..." : "");
	console.log(`Prompt:     ${promptPreview}`);
	console.log(`Agent:      ${agentConfig.configName}`);
	console.log(`Model:      ${opts.model}`);
	console.log(
		`Iterations: ${opts.iterations > 0 ? opts.iterations : "unlimited"}`,
	);
	console.log(
		`Timeout:    ${opts.timeout > 0 ? `${opts.timeout} minutes` : "disabled"}`,
	);
	if (runCtx.structuredTasksFile) {
		console.log(`Tasks:      ${runCtx.structuredTasksFile}`);
		if (runCtx.milestoneFilter)
			console.log(`Milestone:  ${runCtx.milestoneFilter}`);
		const summary = getStructuredTasksSummary(runCtx);
		console.log(`Progress:   ${summary.completed}/${summary.total} complete`);
	}
	console.log("");

	// Start HTTP server
	startHttpServer(runCtx, opts.port);
	console.log(`HTTP server running on http://localhost:${opts.port}`);
	console.log("   POST /context - inject context");
	console.log("   POST /stop    - stop the loop");
	console.log("   GET  /status  - check status");
	console.log("");
	console.log("Starting loop... (Ctrl+C to stop)");
	console.log("=".repeat(68));

	// Initialize state
	const state: RalphState = {
		active: true,
		iteration: 1,
		maxIterations: opts.iterations,
		completionPromise: opts.done,
		tasksMode: !!runCtx.structuredTasksFile,
		taskPromise: opts.next,
		prompt: opts.prompt,
		startedAt: new Date().toISOString(),
		model: opts.model,
		agent: opts.agent,
		workspaceRoot: runCtx.workspaceRoot,
		structuredTasksFile: runCtx.structuredTasksFile,
		milestoneFilter: runCtx.milestoneFilter,
		logFile: runCtx.logFilePath,
	};
	saveState(runCtx, state);

	// Initialize history
	const history: RalphHistory = {
		iterations: [],
		totalDurationMs: 0,
		struggleIndicators: {
			repeatedErrors: {},
			noProgressIterations: 0,
			shortIterations: 0,
		},
	};
	saveHistory(runCtx, history);

	// Track subprocess for cleanup
	let currentProc: ReturnType<typeof Bun.spawn> | null = null;
	let caffeinateProc: ReturnType<typeof Bun.spawn> | null = null;
	let stopping = false;

	// Prevent Mac from sleeping
	if (process.platform === "darwin") {
		try {
			caffeinateProc = Bun.spawn(["caffeinate", "-i"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			console.log("Sleep prevention enabled (caffeinate)");
		} catch {
			console.log(
				"Could not start caffeinate - Mac may sleep during long iterations",
			);
		}
	}

	const stopCaffeinate = () => {
		if (caffeinateProc) {
			try {
				caffeinateProc.kill();
			} catch {}
			caffeinateProc = null;
		}
	};

	process.on("SIGINT", () => {
		if (stopping) {
			console.log("\nForce stopping...");
			stopCaffeinate();
			process.exit(1);
		}
		stopping = true;
		console.log("\nStopping Ralph loop...");
		if (currentProc) {
			try {
				currentProc.kill("SIGKILL");
			} catch {}
		}
		stopCaffeinate();
		clearState(runCtx);
		console.log("Loop cancelled.");
		process.exit(0);
	});

	// Main loop
	while (true) {
		if (opts.iterations > 0 && state.iteration > opts.iterations) {
			console.log(
				`\n+------------------------------------------------------------------+`,
			);
			console.log(`|  Max iterations (${opts.iterations}) reached`);
			console.log(
				`|  Total time: ${formatDurationLong(history.totalDurationMs)}`,
			);
			console.log(
				`+------------------------------------------------------------------+`,
			);
			stopCaffeinate();
			clearState(runCtx);
			break;
		}

		const iterInfo = opts.iterations > 0 ? ` / ${opts.iterations}` : "";
		console.log(`\nIteration ${state.iteration}${iterInfo}`);

		if (runCtx.structuredTasksFile) {
			const summary = getStructuredTasksSummary(runCtx);
			const nextTask = getNextStructuredTask(runCtx);
			console.log(
				`   Tasks: ${summary.completed}/${summary.total} | Next: ${nextTask?.id || "NONE"}`,
			);
		}
		console.log("-".repeat(68));

		const contextAtStart = loadContext(runCtx);
		const snapshotBefore = await captureFileSnapshot();
		const fullPrompt = buildPrompt(runCtx, state, agentConfig);
		const iterationStart = Date.now();

		try {
			const cmdArgs = agentConfig.buildArgs(fullPrompt, opts.model, {
				allowAllPermissions: !opts.interactive,
			});
			const env = agentConfig.buildEnv(runCtx, {
				filterPlugins: opts.noPlugins,
				allowAllPermissions: !opts.interactive,
			});

			currentProc = Bun.spawn([agentConfig.command, ...cmdArgs], {
				env,
				cwd: runCtx.workspaceRoot,
				stdin: "inherit",
				stdout: "pipe",
				stderr: "pipe",
			});

			let result = "";
			let stderr = "";
			let toolCounts = new Map<string, number>();
			let timedOut = false;

			if (!opts.quiet) {
				console.log("Starting agent...");
				const streamed = await streamProcessOutput(currentProc, {
					compactTools: !opts.verbose,
					toolSummaryIntervalMs: 3000,
					heartbeatIntervalMs: 10000,
					iterationStart,
					agent: agentConfig,
					inactivityTimeoutMs: opts.timeout * 60 * 1000,
				});
				result = streamed.stdoutText;
				stderr = streamed.stderrText;
				toolCounts = streamed.toolCounts;
				timedOut = streamed.timedOut;
			} else {
				const stdoutPromise = new Response(
					currentProc.stdout as ReadableStream<Uint8Array>,
				).text();
				const stderrPromise = new Response(
					currentProc.stderr as ReadableStream<Uint8Array>,
				).text();
				[result, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
			}

			const exitCode = await currentProc.exited;
			currentProc = null;

			if (timedOut) {
				console.log(
					`\nProcess killed due to inactivity timeout (${opts.timeout} minutes)`,
				);
			}

			const combinedOutput = `${result}\n${stderr}`;
			const completionDetected = new RegExp(
				`<promise>\\s*${escapeRegex(opts.done)}\\s*</promise>`,
				"i",
			).test(combinedOutput);
			const taskCompletionDetected = new RegExp(
				`<promise>\\s*${escapeRegex(opts.next)}\\s*</promise>`,
				"i",
			).test(combinedOutput);

			// Parse suggested tasks
			const suggestedTasks = parseSuggestedTasks(combinedOutput);
			if (suggestedTasks.length > 0)
				appendSuggestedTasks(runCtx, suggestedTasks, state.iteration);

			const iterationDuration = Date.now() - iterationStart;

			// Print summary
			console.log("\nIteration Summary");
			console.log("-".repeat(68));
			console.log(`Iteration: ${state.iteration}`);
			console.log(`Elapsed:   ${formatDuration(iterationDuration)}`);
			console.log(`Tools:     ${formatToolSummary(toolCounts) || "none"}`);
			console.log(`Exit code: ${exitCode}`);
			console.log(
				`Completion: ${completionDetected ? "detected" : "not detected"}`,
			);

			// Track history
			const snapshotAfter = await captureFileSnapshot();
			const filesModified = getModifiedFilesSinceSnapshot(
				snapshotBefore,
				snapshotAfter,
			);
			const errors = extractErrors(combinedOutput);

			history.iterations.push({
				iteration: state.iteration,
				startedAt: new Date(iterationStart).toISOString(),
				endedAt: new Date().toISOString(),
				durationMs: iterationDuration,
				toolsUsed: Object.fromEntries(toolCounts),
				filesModified,
				exitCode,
				completionDetected,
				errors,
			});
			history.totalDurationMs += iterationDuration;

			// Update struggle indicators
			const madeProgress =
				filesModified.length > 0 ||
				taskCompletionDetected ||
				completionDetected;
			if (!madeProgress) history.struggleIndicators.noProgressIterations++;
			else history.struggleIndicators.noProgressIterations = 0;

			if (iterationDuration < 30000)
				history.struggleIndicators.shortIterations++;
			else history.struggleIndicators.shortIterations = 0;

			if (errors.length === 0) history.struggleIndicators.repeatedErrors = {};
			else {
				for (const error of errors) {
					const key = error.substring(0, 100);
					history.struggleIndicators.repeatedErrors[key] =
						(history.struggleIndicators.repeatedErrors[key] || 0) + 1;
				}
			}
			saveHistory(runCtx, history);

			// Check completion
			if (completionDetected) {
				console.log(
					`\n+------------------------------------------------------------------+`,
				);
				console.log(`|  Completion detected!`);
				console.log(`|  Completed in ${state.iteration} iteration(s)`);
				console.log(
					`|  Total time: ${formatDurationLong(history.totalDurationMs)}`,
				);
				console.log(
					`+------------------------------------------------------------------+`,
				);

				if (runCtx.milestoneFilter) {
					try {
						const tagName = `${runCtx.milestoneFilter.toLowerCase()}-complete`;
						await $`git tag -a ${tagName} -m "Milestone ${runCtx.milestoneFilter} completed"`.quiet();
						console.log(`Tagged: ${tagName}`);
					} catch {}
				}

				stopCaffeinate();
				clearState(runCtx);
				clearHistory(runCtx);
				clearContext(runCtx);
				break;
			}

			if (contextAtStart) {
				console.log(`Context consumed`);
				clearContext(runCtx);
			}

			// Auto-commit
			if (!opts.noCommit) {
				try {
					const status = await $`git status --porcelain`.text();
					if (status.trim()) {
						await $`git add -A`;
						await $`git commit -m "Ralph iteration ${state.iteration}: work in progress"`.quiet();
						console.log(`Auto-committed`);
					}
				} catch {}
			}

			state.iteration++;
			saveState(runCtx, state);
			await new Promise((r) => setTimeout(r, 1000));
		} catch (error) {
			if (currentProc) {
				try {
					currentProc.kill("SIGKILL");
				} catch {}
				currentProc = null;
			}
			console.error(`\nError in iteration ${state.iteration}:`, error);
			console.log("Continuing to next iteration...");

			history.iterations.push({
				iteration: state.iteration,
				startedAt: new Date(iterationStart).toISOString(),
				endedAt: new Date().toISOString(),
				durationMs: Date.now() - iterationStart,
				toolsUsed: {},
				filesModified: [],
				exitCode: -1,
				completionDetected: false,
				errors: [String(error).substring(0, 200)],
			});
			history.totalDurationMs += Date.now() - iterationStart;
			saveHistory(runCtx, history);

			state.iteration++;
			saveState(runCtx, state);
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}
