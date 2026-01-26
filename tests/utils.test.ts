import { describe, expect, test } from "bun:test";
import {
	escapeRegex,
	formatDuration,
	formatDurationLong,
	stripAnsi,
} from "../utils";

describe("stripAnsi", () => {
	test("removes ANSI color codes", () => {
		expect(stripAnsi("\x1B[31mred\x1B[0m")).toBe("red");
		expect(stripAnsi("\x1B[1;32mbold green\x1B[0m")).toBe("bold green");
	});

	test("handles text without ANSI codes", () => {
		expect(stripAnsi("plain text")).toBe("plain text");
		expect(stripAnsi("")).toBe("");
	});

	test("handles multiple ANSI codes", () => {
		expect(stripAnsi("\x1B[31mred\x1B[0m and \x1B[32mgreen\x1B[0m")).toBe(
			"red and green",
		);
	});
});

describe("formatDuration", () => {
	test("formats seconds only", () => {
		expect(formatDuration(0)).toBe("0:00");
		expect(formatDuration(5000)).toBe("0:05");
		expect(formatDuration(59000)).toBe("0:59");
	});

	test("formats minutes and seconds", () => {
		expect(formatDuration(60000)).toBe("1:00");
		expect(formatDuration(90000)).toBe("1:30");
		expect(formatDuration(3599000)).toBe("59:59");
	});

	test("formats hours, minutes, and seconds", () => {
		expect(formatDuration(3600000)).toBe("1:00:00");
		expect(formatDuration(3661000)).toBe("1:01:01");
		expect(formatDuration(7200000)).toBe("2:00:00");
	});

	test("handles negative values", () => {
		expect(formatDuration(-1000)).toBe("0:00");
	});
});

describe("formatDurationLong", () => {
	test("formats seconds only", () => {
		expect(formatDurationLong(0)).toBe("0s");
		expect(formatDurationLong(5000)).toBe("5s");
		expect(formatDurationLong(59000)).toBe("59s");
	});

	test("formats minutes and seconds", () => {
		expect(formatDurationLong(60000)).toBe("1m 0s");
		expect(formatDurationLong(90000)).toBe("1m 30s");
		expect(formatDurationLong(3599000)).toBe("59m 59s");
	});

	test("formats hours, minutes, and seconds", () => {
		expect(formatDurationLong(3600000)).toBe("1h 0m 0s");
		expect(formatDurationLong(3661000)).toBe("1h 1m 1s");
		expect(formatDurationLong(7200000)).toBe("2h 0m 0s");
	});
});

describe("escapeRegex", () => {
	test("escapes special regex characters", () => {
		expect(escapeRegex("hello.world")).toBe("hello\\.world");
		expect(escapeRegex("a*b+c?")).toBe("a\\*b\\+c\\?");
		expect(escapeRegex("(test)")).toBe("\\(test\\)");
		expect(escapeRegex("[abc]")).toBe("\\[abc\\]");
		expect(escapeRegex("a|b")).toBe("a\\|b");
		expect(escapeRegex("^start$end")).toBe("\\^start\\$end");
		expect(escapeRegex("path\\to\\file")).toBe("path\\\\to\\\\file");
	});

	test("handles strings without special characters", () => {
		expect(escapeRegex("hello")).toBe("hello");
		expect(escapeRegex("")).toBe("");
	});
});
