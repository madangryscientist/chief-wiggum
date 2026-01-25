import { describe, expect, test } from "bun:test";

function parseSuggestedTasks(
	output: string,
): Array<{ task: string; milestone: string | null }> {
	const suggestions: Array<{ task: string; milestone: string | null }> = [];
	const regex =
		/<suggest-task(?:\s+milestone="([^"]*)")?\s*>([\s\S]*?)<\/suggest-task>/g;
	let match: RegExpExecArray | null = regex.exec(output);
	while (match !== null) {
		const milestone = match[1] || null;
		const task = match[2].trim();
		if (task) suggestions.push({ task, milestone });
		match = regex.exec(output);
	}
	return suggestions;
}

describe("parseSuggestedTasks", () => {
	test("parses simple suggestion", () => {
		const output = "<suggest-task>Add unit tests for the parser</suggest-task>";
		const suggestions = parseSuggestedTasks(output);

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].task).toBe("Add unit tests for the parser");
		expect(suggestions[0].milestone).toBeNull();
	});

	test("parses suggestion with milestone", () => {
		const output =
			'<suggest-task milestone="M2b">Fix the login bug</suggest-task>';
		const suggestions = parseSuggestedTasks(output);

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].task).toBe("Fix the login bug");
		expect(suggestions[0].milestone).toBe("M2b");
	});

	test("parses multiple suggestions", () => {
		const output = `Some output text
<suggest-task>First task</suggest-task>
More text here
<suggest-task milestone="M1">Second task</suggest-task>
<suggest-task milestone="M2">Third task</suggest-task>`;

		const suggestions = parseSuggestedTasks(output);

		expect(suggestions).toHaveLength(3);
		expect(suggestions[0]).toEqual({ task: "First task", milestone: null });
		expect(suggestions[1]).toEqual({ task: "Second task", milestone: "M1" });
		expect(suggestions[2]).toEqual({ task: "Third task", milestone: "M2" });
	});

	test("handles multiline task descriptions", () => {
		const output = `<suggest-task milestone="M1">
This is a task
with multiple lines
of description
</suggest-task>`;

		const suggestions = parseSuggestedTasks(output);

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].task).toBe(
			"This is a task\nwith multiple lines\nof description",
		);
		expect(suggestions[0].milestone).toBe("M1");
	});

	test("ignores empty suggestions", () => {
		const output = "<suggest-task></suggest-task>";
		const suggestions = parseSuggestedTasks(output);

		expect(suggestions).toHaveLength(0);
	});

	test("ignores whitespace-only suggestions", () => {
		const output = "<suggest-task>   </suggest-task>";
		const suggestions = parseSuggestedTasks(output);

		expect(suggestions).toHaveLength(0);
	});

	test("handles no suggestions in output", () => {
		const output = "Just some regular output without any suggestions";
		const suggestions = parseSuggestedTasks(output);

		expect(suggestions).toHaveLength(0);
	});

	test("handles empty milestone attribute", () => {
		const output = '<suggest-task milestone="">Some task</suggest-task>';
		const suggestions = parseSuggestedTasks(output);

		expect(suggestions).toHaveLength(1);
		expect(suggestions[0].milestone).toBeNull();
	});
});
