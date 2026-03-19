import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 3457;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const TEST_WORKSPACE = join(tmpdir(), `chief-wiggum-test-http-${process.pid}`);
const SCRIPT_PATH = join(import.meta.dir, "..", "chief-wiggum.ts");

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

describe("GET /health", () => {
	test("returns healthy status", async () => {
		const { status, body } = await api("/health");
		expect(status).toBe(200);
		expect(body.status).toBe("healthy");
		expect(body.version).toBeString();
		expect(body.uptime).toBeNumber();
	});
});

describe("GET /status", () => {
	test("returns inactive when no loop", async () => {
		const { status, body } = await api("/status");
		expect(status).toBe(200);
		expect(body.active).toBe(false);
	});
});

describe("GET /history", () => {
	test("returns empty history", async () => {
		const { status, body } = await api("/history");
		expect(status).toBe(200);
		expect(body.iterations).toEqual([]);
		expect(body.totalDurationMs).toBe(0);
	});
});

describe("GET /tasks", () => {
	test("returns zero tasks when no tasks file configured", async () => {
		const { status, body } = await api("/tasks");
		expect(status).toBe(200);
		expect(body.total).toBe(0);
		expect(body.tasks).toEqual([]);
	});
});

describe("POST /context + GET /context", () => {
	test("injects and retrieves context", async () => {
		const post = await api("/context", {
			method: "POST",
			body: JSON.stringify({ text: "focus on auth module" }),
		});
		expect(post.status).toBe(200);
		expect(post.body.success).toBe(true);

		const get1 = await api("/context");
		expect(get1.status).toBe(200);
		expect(get1.body.hasContext).toBe(true);
		expect(get1.body.context).toContain("focus on auth module");
		expect(get1.body.clearedAt).toBeString();

		const get2 = await api("/context");
		expect(get2.status).toBe(200);
		expect(get2.body.hasContext).toBe(false);
		expect(get2.body.context).toBeNull();
	});

	test("rejects missing text field", async () => {
		const { status, body } = await api("/context", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(status).toBe(400);
		expect(body.success).toBe(false);
	});
});

describe("POST /start", () => {
	test("rejects when no prompt provided", async () => {
		const { status, body } = await api("/start", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(status).toBe(400);
		expect(body.success).toBe(false);
	});

	test("starts a loop with inline prompt", async () => {
		const { status, body } = await api("/start", {
			method: "POST",
			body: JSON.stringify({ prompt: "Build a hello world app" }),
		});
		expect(status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.loopId).toBeString();
		expect(body.iteration).toBe(1);
		expect(body.prompt).toContain("Build a hello world app");
	});

	test("overwrites existing loop on second start", async () => {
		const { status, body } = await api("/start", {
			method: "POST",
			body: JSON.stringify({ prompt: "Second prompt" }),
		});
		expect(status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.iteration).toBe(1);
	});

	test("starts a loop with tasks file", async () => {
		const tasksContent = `## M1\n\n- [ ] t01: Create first file\n- [ ] t02: Create second file\n  - depends: t01\n`;
		writeFileSync(join(TEST_WORKSPACE, "tasks.md"), tasksContent);

		const { status, body } = await api("/start", {
			method: "POST",
			body: JSON.stringify({ prompt: "Do the tasks", tasksFile: "tasks.md" }),
		});
		expect(status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.task).toBeDefined();
		expect(body.task.id).toBe("t01");
	});
});

describe("GET /next-task", () => {
	test("returns next task when loop has tasks", async () => {
		const { status, body } = await api("/next-task");
		expect(status).toBe(200);
		expect(body.hasTask).toBe(true);
		expect(body.task.id).toBe("t01");
		expect(body.task.title).toBe("Create first file");
		expect(body.task.depends).toEqual([]);
	});
});

describe("POST /task/mark", () => {
	test("marks task status", async () => {
		const { status, body } = await api("/task/mark", {
			method: "POST",
			body: JSON.stringify({ taskId: "t01", status: "in-progress" }),
		});
		expect(status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.taskId).toBe("t01");
		expect(body.status).toBe("in-progress");
	});

	test("rejects unknown task", async () => {
		const { status, body } = await api("/task/mark", {
			method: "POST",
			body: JSON.stringify({ taskId: "nonexistent", status: "complete" }),
		});
		expect(status).toBe(404);
		expect(body.success).toBe(false);
	});

	test("rejects invalid status", async () => {
		const { status, body } = await api("/task/mark", {
			method: "POST",
			body: JSON.stringify({ taskId: "t01", status: "invalid" }),
		});
		expect(status).toBe(400);
		expect(body.success).toBe(false);
	});
});

describe("POST /iteration/complete", () => {
	test("rejects when no active loop", async () => {
		// Stop any active loop first
		await api("/stop", { method: "POST" });

		const { status, body } = await api("/iteration/complete", {
			method: "POST",
			body: JSON.stringify({ filesModified: [], errors: [] }),
		});
		expect(status).toBe(400);
		expect(body.success).toBe(false);
	});

	test("advances iteration and returns continue", async () => {
		await api("/start", {
			method: "POST",
			body: JSON.stringify({ prompt: "Do work" }),
		});

		const { status, body } = await api("/iteration/complete", {
			method: "POST",
			body: JSON.stringify({ filesModified: ["file.ts"], errors: [] }),
		});
		expect(status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.next).toBe("continue");
		expect(body.iteration).toBe(2);
		expect(body.prompt).toBeString();
	});
});

describe("POST /stop", () => {
	test("stops an active loop", async () => {
		await api("/start", {
			method: "POST",
			body: JSON.stringify({ prompt: "Work" }),
		});

		const { status, body } = await api("/stop", { method: "POST" });
		expect(status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.stoppedAt).toBeString();
	});

	test("rejects when no active loop", async () => {
		// Already stopped
		const { status, body } = await api("/stop", { method: "POST" });
		expect(status).toBe(400);
		expect(body.success).toBe(false);
	});

	test("iteration complete rejects after loop stopped", async () => {
		await api("/start", {
			method: "POST",
			body: JSON.stringify({ prompt: "Work" }),
		});
		await api("/stop", { method: "POST" });

		const { status, body } = await api("/iteration/complete", {
			method: "POST",
			body: JSON.stringify({ filesModified: [] }),
		});
		expect(status).toBe(400);
		expect(body.success).toBe(false);
	});
});

describe("GET /suggested-tasks", () => {
	test("returns null when no file exists", async () => {
		const { status, body } = await api("/suggested-tasks");
		expect(status).toBe(200);
		expect(body.content).toBeNull();
	});
});

describe("GET /logs/raw", () => {
	test("returns empty when no logs", async () => {
		const { status, body } = await api("/logs/raw");
		expect(status).toBe(200);
		expect(body.fileCount).toBe(0);
	});
});

describe("GET /logs", () => {
	test("returns empty archive list", async () => {
		const { status, body } = await api("/logs");
		expect(status).toBe(200);
		expect(body.archivedFiles).toEqual([]);
	});
});

describe("POST /logs/archive", () => {
	test("returns 404 when no log directory exists", async () => {
		const { status } = await api("/logs/archive", { method: "POST" });
		expect(status).toBe(404);
	});
});

describe("unknown routes", () => {
	test("returns 404", async () => {
		const { status, body } = await api("/nonexistent");
		expect(status).toBe(404);
		expect(body.error).toBe("Not found");
	});
});
