import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 3458;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_WORKSPACE = join(tmpdir(), `chief-wiggum-test-loop-${process.pid}`);
const SCRIPT_PATH = join(import.meta.dir, "..", "chief-wiggum.ts");

const TASKS_CONTENT = `## M1

- [ ] t01: Create first file
- [ ] t02: Create second file
  - depends: t01
- [ ] t03: Create summary file
  - depends: t02
`;

let serverProc: ReturnType<typeof Bun.spawn>;

async function api(path: string, options?: RequestInit) {
	const res = await fetch(`${BASE_URL}${path}`, {
		headers: { "Content-Type": "application/json" },
		...options,
	});
	return { status: res.status, body: await res.json() };
}

async function waitForServer(maxMs = 10000) {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		try {
			const res = await fetch(`${BASE_URL}/health`);
			if (res.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`Server did not start within ${maxMs}ms`);
}

beforeAll(async () => {
	if (existsSync(TEST_WORKSPACE)) rmSync(TEST_WORKSPACE, { recursive: true });
	mkdirSync(TEST_WORKSPACE, { recursive: true });

	writeFileSync(join(TEST_WORKSPACE, "tasks.md"), TASKS_CONTENT);

	Bun.spawnSync(["git", "init"], { cwd: TEST_WORKSPACE });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: TEST_WORKSPACE,
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: TEST_WORKSPACE,
	});

	serverProc = Bun.spawn(
		[
			"bun",
			SCRIPT_PATH,
			"serve",
			"--port",
			String(TEST_PORT),
			"--force",
			"-w",
			TEST_WORKSPACE,
			"-t",
			"tasks.md",
		],
		{ cwd: TEST_WORKSPACE, stdout: "ignore", stderr: "ignore" },
	);

	await waitForServer();
});

afterAll(() => {
	try {
		serverProc.kill();
	} catch {}
	if (existsSync(TEST_WORKSPACE)) rmSync(TEST_WORKSPACE, { recursive: true });
});

describe("full loop lifecycle", () => {
	test("completes a 3-task loop", async () => {
		// Start loop
		const start = await api("/start", {
			method: "POST",
			body: JSON.stringify({
				prompt: "Complete all tasks",
				tasksFile: "tasks.md",
			}),
		});
		expect(start.body.success).toBe(true);
		expect(start.body.iteration).toBe(1);
		expect(start.body.task.id).toBe("t01");

		// Verify first task available
		const next1 = await api("/next-task");
		expect(next1.body.hasTask).toBe(true);
		expect(next1.body.task.id).toBe("t01");

		// Work on task 1
		await api("/task/mark", {
			method: "POST",
			body: JSON.stringify({ taskId: "t01", status: "in-progress" }),
		});
		await api("/task/mark", {
			method: "POST",
			body: JSON.stringify({ taskId: "t01", status: "complete" }),
		});

		// Complete iteration 1
		const iter1 = await api("/iteration/complete", {
			method: "POST",
			body: JSON.stringify({
				filesModified: ["file1.txt"],
				errors: [],
				completionDetected: true,
			}),
		});
		expect(iter1.body.success).toBe(true);
		expect(iter1.body.next).toBe("continue");
		expect(iter1.body.iteration).toBe(2);

		// Task 2 should now be available (depends on t01 which is complete)
		const next2 = await api("/next-task");
		expect(next2.body.hasTask).toBe(true);
		expect(next2.body.task.id).toBe("t02");

		// Work on task 2
		await api("/task/mark", {
			method: "POST",
			body: JSON.stringify({ taskId: "t02", status: "in-progress" }),
		});
		await api("/task/mark", {
			method: "POST",
			body: JSON.stringify({ taskId: "t02", status: "complete" }),
		});

		// Complete iteration 2
		const iter2 = await api("/iteration/complete", {
			method: "POST",
			body: JSON.stringify({
				filesModified: ["file2.txt"],
				errors: [],
				completionDetected: true,
			}),
		});
		expect(iter2.body.success).toBe(true);
		expect(iter2.body.next).toBe("continue");
		expect(iter2.body.iteration).toBe(3);

		// Task 3 should now be available
		const next3 = await api("/next-task");
		expect(next3.body.hasTask).toBe(true);
		expect(next3.body.task.id).toBe("t03");

		// Work on task 3
		await api("/task/mark", {
			method: "POST",
			body: JSON.stringify({ taskId: "t03", status: "in-progress" }),
		});
		await api("/task/mark", {
			method: "POST",
			body: JSON.stringify({ taskId: "t03", status: "complete" }),
		});

		// Complete iteration 3 — all tasks done, should return complete
		const iter3 = await api("/iteration/complete", {
			method: "POST",
			body: JSON.stringify({
				filesModified: ["summary.txt"],
				errors: [],
				completionDetected: true,
			}),
		});
		expect(iter3.body.success).toBe(true);
		expect(iter3.body.next).toBe("complete");
	});
});

describe("context injection mid-loop", () => {
	test("injects and retrieves context during a loop", async () => {
		// Rewrite tasks file fresh (previous test completed all tasks)
		writeFileSync(join(TEST_WORKSPACE, "tasks.md"), TASKS_CONTENT);

		await api("/start", {
			method: "POST",
			body: JSON.stringify({ prompt: "Do work", tasksFile: "tasks.md" }),
		});

		// Inject context mid-loop
		const inject = await api("/context", {
			method: "POST",
			body: JSON.stringify({ text: "focus on performance" }),
		});
		expect(inject.body.success).toBe(true);

		// Retrieve context (should be present)
		const ctx = await api("/context");
		expect(ctx.body.hasContext).toBe(true);
		expect(ctx.body.context).toContain("focus on performance");

		// Second read should be empty (cleared)
		const ctx2 = await api("/context");
		expect(ctx2.body.hasContext).toBe(false);
	});
});

describe("struggle indicators", () => {
	test("tracks no-progress iterations", async () => {
		writeFileSync(join(TEST_WORKSPACE, "tasks.md"), TASKS_CONTENT);

		await api("/start", {
			method: "POST",
			body: JSON.stringify({ prompt: "Do work", tasksFile: "tasks.md" }),
		});

		// Two iterations with no files modified and no completion
		await api("/iteration/complete", {
			method: "POST",
			body: JSON.stringify({
				filesModified: [],
				errors: [],
				completionDetected: false,
			}),
		});
		await api("/iteration/complete", {
			method: "POST",
			body: JSON.stringify({
				filesModified: [],
				errors: [],
				completionDetected: false,
			}),
		});

		const { body } = await api("/history");
		expect(body.iterations.length).toBeGreaterThanOrEqual(2);
		expect(body.struggleIndicators.noProgressIterations).toBeGreaterThanOrEqual(
			2,
		);
	});

	test("tracks repeated errors", async () => {
		writeFileSync(join(TEST_WORKSPACE, "tasks.md"), TASKS_CONTENT);

		await api("/start", {
			method: "POST",
			body: JSON.stringify({ prompt: "Do work", tasksFile: "tasks.md" }),
		});

		await api("/iteration/complete", {
			method: "POST",
			body: JSON.stringify({
				filesModified: [],
				errors: ["TypeError: cannot read property"],
				completionDetected: false,
			}),
		});
		await api("/iteration/complete", {
			method: "POST",
			body: JSON.stringify({
				filesModified: [],
				errors: ["TypeError: cannot read property"],
				completionDetected: false,
			}),
		});

		const { body } = await api("/history");
		const errorKey = "TypeError: cannot read property";
		expect(
			body.struggleIndicators.repeatedErrors[errorKey],
		).toBeGreaterThanOrEqual(2);
	});
});

describe("task dependency enforcement", () => {
	test("next-task respects dependency order", async () => {
		writeFileSync(join(TEST_WORKSPACE, "tasks.md"), TASKS_CONTENT);

		await api("/start", {
			method: "POST",
			body: JSON.stringify({ prompt: "Do tasks", tasksFile: "tasks.md" }),
		});

		// First available task should be t01 (no deps)
		const next1 = await api("/next-task");
		expect(next1.body.task.id).toBe("t01");

		// Mark t01 complete
		await api("/task/mark", {
			method: "POST",
			body: JSON.stringify({ taskId: "t01", status: "complete" }),
		});

		// Now t02 should be available
		const next2 = await api("/next-task");
		expect(next2.body.task.id).toBe("t02");

		// t03 should NOT be available yet (depends on t02)
		// We verify by checking that next-task returns t02, not t03
		expect(next2.body.task.id).not.toBe("t03");
	});
});
