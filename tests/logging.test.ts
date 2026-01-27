import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const TEST_WORKSPACE = join(import.meta.dir, ".test-workspace");
const TEST_RALPH_DIR = join(TEST_WORKSPACE, ".ralph");
const TEST_LOG_DIR = join(TEST_RALPH_DIR, "logs");

describe("logging integration", () => {
	beforeAll(() => {
		if (existsSync(TEST_WORKSPACE)) {
			rmSync(TEST_WORKSPACE, { recursive: true });
		}
		mkdirSync(TEST_WORKSPACE, { recursive: true });
		// Initialize git repo (required for chief-wiggum)
		Bun.spawnSync(["git", "init"], { cwd: TEST_WORKSPACE });
		Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: TEST_WORKSPACE });
		Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: TEST_WORKSPACE });
	});

	afterAll(() => {
		if (existsSync(TEST_WORKSPACE)) {
			rmSync(TEST_WORKSPACE, { recursive: true });
		}
	});

	test("logs opencode output to file", async () => {
		const testPrompt = "Say exactly: TEST_OUTPUT_12345 and nothing else. Then output <promise>COMPLETE</promise>";
		const testPort = 30000 + Math.floor(Math.random() * 10000);
		
		// Run chief-wiggum with a simple prompt that should complete in one iteration
		const proc = Bun.spawn(
			[
				"bun",
				join(import.meta.dir, "..", "chief-wiggum.ts"),
				"run",
				testPrompt,
				"-n", "1",
				"--timeout", "2",
				"--no-commit",
				"-w", TEST_WORKSPACE,
				"-p", String(testPort),
			],
			{
				cwd: TEST_WORKSPACE,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					// Ensure we use a fast model for testing
					OPENCODE_MODEL: "anthropic/claude-sonnet-4-5",
				},
			}
		);

		// Wait for process with timeout
		const timeout = setTimeout(() => {
			proc.kill();
		}, 120000); // 2 minute timeout

		const exitCode = await proc.exited;
		clearTimeout(timeout);

		// Read stdout/stderr for debugging
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();

		console.log("=== STDOUT ===");
		console.log(stdout);
		console.log("=== STDERR ===");
		console.log(stderr);

		// Check log directory was created
		expect(existsSync(TEST_LOG_DIR)).toBe(true);

		// Find the log file
		const logFiles = readdirSync(TEST_LOG_DIR).filter(f => f.endsWith(".log"));
		expect(logFiles.length).toBeGreaterThan(0);

		// Read the most recent log file
		const logFile = join(TEST_LOG_DIR, logFiles[logFiles.length - 1]);
		const logContent = readFileSync(logFile, "utf-8");

		console.log("=== LOG FILE ===");
		console.log(logContent);

		// Verify log contains expected content
		expect(logContent).toContain("Ralph Wiggum Session Log");
		expect(logContent).toContain("Iteration 1");
		
		// The agent output should be in the log
		// Either the test phrase or at least some agent activity
		const hasAgentOutput = 
			logContent.includes("TEST_OUTPUT_12345") ||
			logContent.includes("Starting agent") ||
			logContent.includes("Tools");
		
		expect(hasAgentOutput).toBe(true);
	}, 180000); // 3 minute test timeout
});
