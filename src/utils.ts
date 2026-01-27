import { $ } from "bun";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes require control characters
const ANSI_REGEX = /\x1B\[[0-9;]*m/g;

export function stripAnsi(input: string): string {
	return input.replace(ANSI_REGEX, "");
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0)
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatDurationLong(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function killProcessTree(pid: number): Promise<void> {
	if (process.platform === "darwin" || process.platform === "linux") {
		try {
			await $`pkill -9 -P ${pid}`.quiet();
		} catch {}
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	} else {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}
