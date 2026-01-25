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
