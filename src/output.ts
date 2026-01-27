import { $ } from "bun";
import type { AgentConfig } from "./agents";
import { formatDuration, killProcessTree } from "./utils";

export interface FileSnapshot {
	files: Map<string, string>;
}

export function formatToolSummary(
	toolCounts: Map<string, number>,
	maxItems = 6,
): string {
	if (!toolCounts.size) return "";
	const entries = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1]);
	const shown = entries.slice(0, maxItems);
	const remaining = entries.length - shown.length;
	const parts = shown.map(([name, count]) => `${name} ${count}`);
	if (remaining > 0) parts.push(`+${remaining} more`);
	return parts.join(" . ");
}

export async function captureFileSnapshot(): Promise<FileSnapshot> {
	const files = new Map<string, string>();
	try {
		const status = await $`git status --porcelain`.text();
		const modifiedFiles: string[] = [];
		for (const line of status.split("\n")) {
			if (line.trim()) modifiedFiles.push(line.substring(3).trim());
		}
		for (const file of modifiedFiles) {
			try {
				const hash = await $`git hash-object ${file} 2>/dev/null`.text();
				files.set(file, hash.trim());
			} catch {}
		}
	} catch {}
	return { files };
}

export function getModifiedFilesSinceSnapshot(
	before: FileSnapshot,
	after: FileSnapshot,
): string[] {
	const changedFiles: string[] = [];
	for (const [file, hash] of after.files) {
		if (before.files.get(file) !== hash) changedFiles.push(file);
	}
	for (const [file] of before.files) {
		if (!after.files.has(file)) changedFiles.push(file);
	}
	return changedFiles;
}

export function extractErrors(output: string): string[] {
	const errors: string[] = [];
	const lines = output.split("\n");
	for (const line of lines) {
		const lower = line.toLowerCase();
		if (
			lower.includes("error:") ||
			lower.includes("failed:") ||
			lower.includes("exception:") ||
			lower.includes("typeerror") ||
			lower.includes("syntaxerror") ||
			lower.includes("referenceerror") ||
			(lower.includes("test") && lower.includes("fail"))
		) {
			const cleaned = line.trim().substring(0, 200);
			if (cleaned && !errors.includes(cleaned)) errors.push(cleaned);
		}
	}
	return errors.slice(0, 10);
}

export interface StreamOutputOptions {
	compactTools: boolean;
	toolSummaryIntervalMs: number;
	heartbeatIntervalMs: number;
	iterationStart: number;
	agent: AgentConfig;
	inactivityTimeoutMs: number;
}

export interface StreamOutputResult {
	stdoutText: string;
	stderrText: string;
	toolCounts: Map<string, number>;
	timedOut: boolean;
}

export async function streamProcessOutput(
	proc: ReturnType<typeof Bun.spawn>,
	options: StreamOutputOptions,
): Promise<StreamOutputResult> {
	const toolCounts = new Map<string, number>();
	let stdoutText = "";
	let stderrText = "";
	let lastPrintedAt = Date.now();
	let lastActivityAt = Date.now();
	let lastToolSummaryAt = 0;
	let timedOut = false;

	const maybePrintToolSummary = (force = false) => {
		if (!options.compactTools || toolCounts.size === 0) return;
		const now = Date.now();
		if (!force && now - lastToolSummaryAt < options.toolSummaryIntervalMs)
			return;
		const summary = formatToolSummary(toolCounts);
		if (summary) {
			console.log(`| Tools    ${summary}`);
			lastPrintedAt = Date.now();
			lastToolSummaryAt = Date.now();
		}
	};

	const handleLine = (line: string, isError: boolean) => {
		lastActivityAt = Date.now();
		const tool = options.agent.parseToolOutput(line);
		if (tool) {
			toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
			if (options.compactTools) {
				maybePrintToolSummary();
				return;
			}
		}
		if (line.length === 0) {
			console.log("");
			lastPrintedAt = Date.now();
			return;
		}
		if (isError) console.error(line);
		else console.log(line);
		lastPrintedAt = Date.now();
	};

	const streamText = async (
		stream: ReadableStream<Uint8Array> | null,
		onText: (chunk: string) => void,
		isError: boolean,
		shouldExit: () => boolean,
	) => {
		if (!stream) return;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		const readWithTimeout = async (): Promise<{
			value?: Uint8Array;
			done: boolean;
		} | null> => {
			const readPromise = reader.read();
			while (true) {
				const result = await Promise.race([
					readPromise,
					new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
				]);
				if (result !== null) return result;
				if (shouldExit()) {
					try {
						reader.cancel();
					} catch {}
					return { done: true };
				}
			}
		};

		while (true) {
			if (shouldExit()) {
				try {
					reader.cancel();
				} catch {}
				break;
			}
			const result = await readWithTimeout();
			if (!result || result.done) break;
			const text = decoder.decode(result.value, { stream: true });
			if (text.length > 0) {
				onText(text);
				buffer += text;
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() ?? "";
				for (const line of lines) handleLine(line, isError);
			}
		}
		const flushed = decoder.decode();
		if (flushed.length > 0) {
			onText(flushed);
			buffer += flushed;
		}
		if (buffer.length > 0) handleLine(buffer, isError);
	};

	let killAttempts = 0;
	let forceExit = false;

	const heartbeatTimer = setInterval(async () => {
		const now = Date.now();
		const inactivityDuration = now - lastActivityAt;

		if (
			options.inactivityTimeoutMs > 0 &&
			inactivityDuration >= options.inactivityTimeoutMs
		) {
			timedOut = true;
			killAttempts++;

			if (killAttempts === 1) {
				console.log(
					`\n INACTIVITY TIMEOUT: No output for ${formatDuration(inactivityDuration)}. Sending SIGTERM...`,
				);
				try {
					proc.kill("SIGTERM");
				} catch {}
			} else if (killAttempts === 2) {
				console.log(`Process didn't respond to SIGTERM. Sending SIGKILL...`);
				try {
					proc.kill("SIGKILL");
				} catch {}
			} else if (killAttempts === 3) {
				console.log(`Killing process tree (PID: ${proc.pid})...`);
				await killProcessTree(proc.pid);
			} else if (killAttempts >= 4) {
				forceExit = true;
			}
			return;
		}

		if (now - lastPrintedAt >= options.heartbeatIntervalMs) {
			const elapsed = formatDuration(now - options.iterationStart);
			const sinceActivity = formatDuration(now - lastActivityAt);
			const timeoutIn =
				options.inactivityTimeoutMs > 0
					? ` . timeout in ${formatDuration(options.inactivityTimeoutMs - inactivityDuration)}`
					: "";
			console.log(
				`working... elapsed ${elapsed} . last activity ${sinceActivity} ago${timeoutIn}`,
			);
			lastPrintedAt = now;
		}
	}, options.heartbeatIntervalMs);

	try {
		await Promise.all([
			streamText(
				proc.stdout as ReadableStream<Uint8Array> | null,
				(chunk) => {
					stdoutText += chunk;
				},
				false,
				() => forceExit,
			),
			streamText(
				proc.stderr as ReadableStream<Uint8Array> | null,
				(chunk) => {
					stderrText += chunk;
				},
				true,
				() => forceExit,
			),
		]);
	} finally {
		clearInterval(heartbeatTimer);
	}

	if (forceExit) {
		console.log(`Force-exiting stream readers after timeout`);
		await killProcessTree(proc.pid);
	}

	if (options.compactTools) maybePrintToolSummary(true);

	return { stdoutText, stderrText, toolCounts, timedOut };
}
