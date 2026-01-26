import { describe, expect, test } from "bun:test";

interface Task {
	text: string;
	status: "todo" | "in-progress" | "complete";
	subtasks: Task[];
	originalLine: string;
}

interface StructuredTask {
	id: string;
	title: string;
	milestone: string | null;
	status: "todo" | "in-progress" | "complete";
	depends: string[];
	verify: string | null;
	started: string | null;
	completed: string | null;
	originalLines: string[];
}

interface ParsedTasksFile {
	milestones: Map<string, StructuredTask[]>;
	allTasks: Map<string, StructuredTask>;
}

function parseTasks(content: string): Task[] {
	const tasks: Task[] = [];
	const lines = content.split("\n");
	let currentTask: Task | null = null;

	for (const line of lines) {
		const topLevelMatch = line.match(/^- \[([ x/])\]\s*(.+)/);
		if (topLevelMatch) {
			if (currentTask) tasks.push(currentTask);
			const [, statusChar, text] = topLevelMatch;
			let status: Task["status"] = "todo";
			if (statusChar === "x") status = "complete";
			else if (statusChar === "/") status = "in-progress";
			currentTask = { text, status, subtasks: [], originalLine: line };
			continue;
		}

		const subtaskMatch = line.match(/^\s+- \[([ x/])\]\s*(.+)/);
		if (subtaskMatch && currentTask) {
			const [, statusChar, text] = subtaskMatch;
			let status: Task["status"] = "todo";
			if (statusChar === "x") status = "complete";
			else if (statusChar === "/") status = "in-progress";
			currentTask.subtasks.push({
				text,
				status,
				subtasks: [],
				originalLine: line,
			});
		}
	}

	if (currentTask) tasks.push(currentTask);
	return tasks;
}

function parseStructuredTasks(content: string): ParsedTasksFile {
	const milestones = new Map<string, StructuredTask[]>();
	const allTasks = new Map<string, StructuredTask>();
	const lines = content.split("\n");

	let currentMilestone: string | null = null;
	let currentTask: StructuredTask | null = null;
	let taskLines: string[] = [];

	const saveCurrentTask = () => {
		if (currentTask) {
			currentTask.originalLines = [...taskLines];
			allTasks.set(currentTask.id, currentTask);
			if (currentMilestone) {
				const tasks = milestones.get(currentMilestone) || [];
				tasks.push(currentTask);
				milestones.set(currentMilestone, tasks);
			}
		}
		currentTask = null;
		taskLines = [];
	};

	for (const line of lines) {
		const milestoneMatch = line.match(/^##\s+(\S+)(?::\s*(.*))?$/);
		if (milestoneMatch) {
			saveCurrentTask();
			currentMilestone = milestoneMatch[1];
			if (!milestones.has(currentMilestone))
				milestones.set(currentMilestone, []);
			continue;
		}

		const taskMatch = line.match(
			/^-\s+\[([ x/])\]\s+([a-zA-Z0-9_-]+):\s*(.+)$/,
		);
		if (taskMatch) {
			saveCurrentTask();
			const [, statusChar, id, title] = taskMatch;
			let status: StructuredTask["status"] = "todo";
			if (statusChar === "x") status = "complete";
			else if (statusChar === "/") status = "in-progress";

			currentTask = {
				id,
				title,
				milestone: currentMilestone,
				status,
				depends: [],
				verify: null,
				started: null,
				completed: null,
				originalLines: [],
			};
			taskLines = [line];
			continue;
		}

		if (currentTask && line.match(/^\s+-\s+\w+:/)) {
			taskLines.push(line);

			const dependsMatch = line.match(/^\s+-\s+depends:\s*(.+)$/);
			if (dependsMatch) {
				currentTask.depends = dependsMatch[1].split(/[,\s]+/).filter(Boolean);
				continue;
			}

			const verifyMatch = line.match(/^\s+-\s+verify:\s*`?([^`]+)`?$/);
			if (verifyMatch) {
				currentTask.verify = verifyMatch[1].trim();
				continue;
			}

			const startedMatch = line.match(/^\s+-\s+started:\s*(.+)$/);
			if (startedMatch) {
				currentTask.started = startedMatch[1].trim();
				continue;
			}

			const completedMatch = line.match(/^\s+-\s+completed:\s*(.+)$/);
			if (completedMatch) {
				currentTask.completed = completedMatch[1].trim();
			}
		}
	}

	saveCurrentTask();
	return { milestones, allTasks };
}

describe("parseTasks", () => {
	test("parses simple tasks", () => {
		const content = `- [ ] Task 1
- [x] Task 2
- [/] Task 3`;

		const tasks = parseTasks(content);
		expect(tasks).toHaveLength(3);
		expect(tasks[0].text).toBe("Task 1");
		expect(tasks[0].status).toBe("todo");
		expect(tasks[1].text).toBe("Task 2");
		expect(tasks[1].status).toBe("complete");
		expect(tasks[2].text).toBe("Task 3");
		expect(tasks[2].status).toBe("in-progress");
	});

	test("parses tasks with subtasks", () => {
		const content = `- [ ] Main task
  - [ ] Subtask 1
  - [x] Subtask 2`;

		const tasks = parseTasks(content);
		expect(tasks).toHaveLength(1);
		expect(tasks[0].subtasks).toHaveLength(2);
		expect(tasks[0].subtasks[0].text).toBe("Subtask 1");
		expect(tasks[0].subtasks[0].status).toBe("todo");
		expect(tasks[0].subtasks[1].text).toBe("Subtask 2");
		expect(tasks[0].subtasks[1].status).toBe("complete");
	});

	test("handles empty content", () => {
		expect(parseTasks("")).toHaveLength(0);
		expect(parseTasks("# Header\nSome text")).toHaveLength(0);
	});
});

describe("parseStructuredTasks", () => {
	test("parses milestone and tasks", () => {
		const content = `## M1

- [ ] task-001: First task
  - verify: \`test passes\`

- [x] task-002: Second task
  - depends: task-001
  - completed: 2024-01-01`;

		const result = parseStructuredTasks(content);

		expect(result.milestones.has("M1")).toBe(true);
		expect(result.milestones.get("M1")).toHaveLength(2);

		const task1 = result.allTasks.get("task-001");
		expect(task1).toBeDefined();
		expect(task1?.title).toBe("First task");
		expect(task1?.status).toBe("todo");
		expect(task1?.verify).toBe("test passes");
		expect(task1?.milestone).toBe("M1");

		const task2 = result.allTasks.get("task-002");
		expect(task2).toBeDefined();
		expect(task2?.title).toBe("Second task");
		expect(task2?.status).toBe("complete");
		expect(task2?.depends).toEqual(["task-001"]);
		expect(task2?.completed).toBe("2024-01-01");
	});

	test("parses multiple milestones", () => {
		const content = `## M1

- [ ] m1-001: M1 Task

## M2

- [ ] m2-001: M2 Task`;

		const result = parseStructuredTasks(content);

		expect(result.milestones.has("M1")).toBe(true);
		expect(result.milestones.has("M2")).toBe(true);
		expect(result.milestones.get("M1")).toHaveLength(1);
		expect(result.milestones.get("M2")).toHaveLength(1);
	});

	test("parses in-progress tasks", () => {
		const content = `## M1

- [/] task-001: In progress task
  - started: 2024-01-01T10:00:00Z`;

		const result = parseStructuredTasks(content);
		const task = result.allTasks.get("task-001");

		expect(task).toBeDefined();
		expect(task?.status).toBe("in-progress");
		expect(task?.started).toBe("2024-01-01T10:00:00Z");
	});

	test("parses multiple dependencies", () => {
		const content = `## M1

- [ ] task-003: Third task
  - depends: task-001, task-002`;

		const result = parseStructuredTasks(content);
		const task = result.allTasks.get("task-003");

		expect(task).toBeDefined();
		expect(task?.depends).toEqual(["task-001", "task-002"]);
	});

	test("handles empty content", () => {
		const result = parseStructuredTasks("");
		expect(result.milestones.size).toBe(0);
		expect(result.allTasks.size).toBe(0);
	});
});

// Pure function version of updateStructuredTaskStatus for testing
function updateStructuredTaskStatusContent(
	content: string,
	taskId: string,
	newStatus: "todo" | "in-progress" | "complete",
): { success: boolean; content?: string; error?: string } {
	const lines = content.split("\n");
	const newLines: string[] = [];
	let found = false;
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const taskMatch = line.match(
			/^(-\s+\[)([ x/])(\]\s+`?)([a-zA-Z0-9_-]+)(`?\s+.+)$/,
		);

		if (taskMatch && taskMatch[4] === taskId) {
			found = true;
			const statusChar =
				newStatus === "complete"
					? "x"
					: newStatus === "in-progress"
						? "/"
						: " ";
			newLines.push(
				`${taskMatch[1]}${statusChar}${taskMatch[3]}${taskMatch[4]}${taskMatch[5]}`,
			);
			i++;

			// Scan ahead to find existing metadata lines and detect started/completed
			let hasStarted = false;
			let hasCompleted = false;
			const metadataStartIndex = i;
			let metadataEndIndex = i;

			while (
				metadataEndIndex < lines.length &&
				lines[metadataEndIndex].match(/^\s+-\s+\w+:/)
			) {
				const metaLine = lines[metadataEndIndex];
				if (metaLine.match(/^\s+-\s+started:/)) {
					hasStarted = true;
				}
				if (metaLine.match(/^\s+-\s+completed:/)) {
					hasCompleted = true;
				}
				metadataEndIndex++;
			}

			// Add started timestamp if marking in-progress and not already present
			if (newStatus === "in-progress" && !hasStarted) {
				newLines.push(`  - started: TIMESTAMP`);
			}

			// Copy existing metadata lines, skipping completed if we're re-completing
			for (let j = metadataStartIndex; j < metadataEndIndex; j++) {
				const metaLine = lines[j];
				if (newStatus === "complete" && metaLine.match(/^\s+-\s+completed:/)) {
					// Skip old completed line, we'll add a new one
					continue;
				}
				newLines.push(metaLine);
			}
			i = metadataEndIndex;

			// Add completed timestamp if marking complete
			if (newStatus === "complete") {
				newLines.push(`  - completed: TIMESTAMP`);
			}
		} else {
			newLines.push(line);
			i++;
		}
	}

	if (!found) {
		return { success: false, error: `Task not found: ${taskId}` };
	}

	return { success: true, content: newLines.join("\n") };
}

describe("updateStructuredTaskStatus", () => {
	test("marks task as in-progress and adds started timestamp", () => {
		const content = `## M1

- [ ] \`task-001\` First task`;

		const result = updateStructuredTaskStatusContent(
			content,
			"task-001",
			"in-progress",
		);

		expect(result.success).toBe(true);
		expect(result.content).toContain("- [/] `task-001`");
		expect(result.content).toContain("  - started: TIMESTAMP");
	});

	test("marks task as complete and adds completed timestamp", () => {
		const content = `## M1

- [/] \`task-001\` First task
  - started: 2024-01-01T10:00:00Z`;

		const result = updateStructuredTaskStatusContent(
			content,
			"task-001",
			"complete",
		);

		expect(result.success).toBe(true);
		expect(result.content).toContain("- [x] `task-001`");
		expect(result.content).toContain("  - started: 2024-01-01T10:00:00Z");
		expect(result.content).toContain("  - completed: TIMESTAMP");
	});

	test("preserves existing started timestamp when marking complete", () => {
		const content = `## M1

- [/] \`task-001\` First task
  - started: 2024-01-01T10:00:00Z`;

		const result = updateStructuredTaskStatusContent(
			content,
			"task-001",
			"complete",
		);

		expect(result.success).toBe(true);
		expect(result.content).toContain("  - started: 2024-01-01T10:00:00Z");
	});

	test("does not add started timestamp if already present", () => {
		const content = `## M1

- [ ] \`task-001\` First task
  - started: 2024-01-01T10:00:00Z`;

		const result = updateStructuredTaskStatusContent(
			content,
			"task-001",
			"in-progress",
		);

		expect(result.success).toBe(true);
		// Should only have one started line
		const startedMatches = result.content?.match(/started:/g);
		expect(startedMatches).toHaveLength(1);
		expect(result.content).toContain("  - started: 2024-01-01T10:00:00Z");
	});

	test("replaces completed timestamp when re-completing", () => {
		const content = `## M1

- [x] \`task-001\` First task
  - started: 2024-01-01T10:00:00Z
  - completed: 2024-01-01T11:00:00Z`;

		const result = updateStructuredTaskStatusContent(
			content,
			"task-001",
			"complete",
		);

		expect(result.success).toBe(true);
		// Should only have one completed line (the new TIMESTAMP)
		const completedMatches = result.content?.match(/completed:/g);
		expect(completedMatches).toHaveLength(1);
		expect(result.content).toContain("  - completed: TIMESTAMP");
		expect(result.content).not.toContain("2024-01-01T11:00:00Z");
	});

	test("handles task with only completed metadata (no started)", () => {
		const content = `## M1

- [x] \`task-001\` First task
  - completed: 2024-01-01T11:00:00Z`;

		const result = updateStructuredTaskStatusContent(
			content,
			"task-001",
			"complete",
		);

		expect(result.success).toBe(true);
		expect(result.content).toContain("- [x] `task-001`");
		expect(result.content).toContain("  - completed: TIMESTAMP");
		expect(result.content).not.toContain("2024-01-01T11:00:00Z");
	});

	test("handles multiple metadata fields in different orders", () => {
		const content = `## M1

- [/] \`task-001\` First task
  - depends: task-000
  - started: 2024-01-01T10:00:00Z
  - verify: \`bun test\``;

		const result = updateStructuredTaskStatusContent(
			content,
			"task-001",
			"complete",
		);

		expect(result.success).toBe(true);
		expect(result.content).toContain("- [x] `task-001`");
		expect(result.content).toContain("  - depends: task-000");
		expect(result.content).toContain("  - started: 2024-01-01T10:00:00Z");
		expect(result.content).toContain("  - verify: `bun test`");
		expect(result.content).toContain("  - completed: TIMESTAMP");
	});

	test("handles metadata with completed before started", () => {
		const content = `## M1

- [x] \`task-001\` First task
  - completed: 2024-01-01T11:00:00Z
  - started: 2024-01-01T10:00:00Z`;

		const result = updateStructuredTaskStatusContent(
			content,
			"task-001",
			"complete",
		);

		expect(result.success).toBe(true);
		// Old completed should be removed, started preserved, new completed added
		expect(result.content).toContain("  - started: 2024-01-01T10:00:00Z");
		expect(result.content).toContain("  - completed: TIMESTAMP");
		expect(result.content).not.toContain("2024-01-01T11:00:00Z");
	});

	test("status transition: todo -> in-progress -> complete", () => {
		let content = `## M1

- [ ] \`task-001\` First task`;

		// todo -> in-progress
		let result = updateStructuredTaskStatusContent(
			content,
			"task-001",
			"in-progress",
		);
		expect(result.success).toBe(true);
		expect(result.content).toContain("- [/] `task-001`");
		expect(result.content).toContain("  - started: TIMESTAMP");

		// in-progress -> complete (simulate by using the updated content with a real started time)
		content = `## M1

- [/] \`task-001\` First task
  - started: 2024-01-01T10:00:00Z`;

		result = updateStructuredTaskStatusContent(content, "task-001", "complete");
		expect(result.success).toBe(true);
		expect(result.content).toContain("- [x] `task-001`");
		expect(result.content).toContain("  - started: 2024-01-01T10:00:00Z");
		expect(result.content).toContain("  - completed: TIMESTAMP");
	});

	test("returns error for non-existent task", () => {
		const content = `## M1

- [ ] \`task-001\` First task`;

		const result = updateStructuredTaskStatusContent(
			content,
			"task-999",
			"complete",
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("Task not found: task-999");
	});

	test("handles task without backticks", () => {
		const content = `## M1

- [ ] task-001 First task`;

		const result = updateStructuredTaskStatusContent(
			content,
			"task-001",
			"in-progress",
		);

		expect(result.success).toBe(true);
		expect(result.content).toContain("- [/]");
		expect(result.content).toContain("task-001");
	});
});
