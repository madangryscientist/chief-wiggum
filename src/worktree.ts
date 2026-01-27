import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

export function extractWorktreeName(promptContent: string): string {
	const match = promptContent.match(/^#\s+(.+)$/m);
	if (!match) {
		console.error("Error: No # heading found in prompt file.");
		process.exit(1);
	}
	return match[1]
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export async function branchExists(
	repoDir: string,
	branch: string,
): Promise<boolean> {
	try {
		const localResult =
			await $`git -C ${repoDir} branch --list ${branch}`.text();
		if (localResult.trim()) return true;
		const remoteResult =
			await $`git -C ${repoDir} branch -r --list origin/${branch}`.text();
		return !!remoteResult.trim();
	} catch {
		return false;
	}
}

export async function getDefaultBranch(repoDir: string): Promise<string> {
	try {
		const result =
			await $`git -C ${repoDir} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`.text();
		const match = result.match(/refs\/remotes\/origin\/(.+)/);
		if (match) return match[1].trim();
	} catch {}

	try {
		await $`git -C ${repoDir} rev-parse --verify origin/main`.quiet();
		return "main";
	} catch {
		try {
			await $`git -C ${repoDir} rev-parse --verify origin/master`.quiet();
			return "master";
		} catch {
			console.error("Error: Could not find origin/main or origin/master");
			process.exit(1);
		}
	}
	return "main";
}

export async function confirm(message: string): Promise<boolean> {
	process.stdout.write(`${message} [y/N] `);
	const reader = Bun.stdin.stream().getReader();
	const { value } = await reader.read();
	reader.releaseLock();
	const answer = new TextDecoder().decode(value).trim().toLowerCase();
	return answer === "y" || answer === "yes";
}

export async function setupWorktree(
	repo: string,
	promptContent: string,
	branch: string | null,
	promptFilePath: string,
	tasksFilePath: string | null,
): Promise<{
	worktreePath: string;
	promptFile: string;
	tasksFile: string | null;
}> {
	if (!existsSync(join(repo, ".git"))) {
		console.error(`Error: Not a git repository: ${repo}`);
		process.exit(1);
	}

	const worktreeName = extractWorktreeName(promptContent);
	const worktreePath = `${repo}.worktrees/${worktreeName}`;
	const effectiveBranch = branch || worktreeName;

	console.log(`\n📁 Worktree Setup`);
	console.log(`   Name: ${worktreeName}`);
	console.log(`   Path: ${worktreePath}`);
	console.log(`   Branch: ${effectiveBranch}`);

	if (existsSync(worktreePath)) {
		console.log(`   Status: Using existing worktree`);
		return {
			worktreePath,
			promptFile: join(worktreePath, ".ralph", "ralph-prompt.md"),
			tasksFile: tasksFilePath,
		};
	}

	console.log(`   Fetching from origin...`);
	try {
		await $`git -C ${repo} fetch origin`.quiet();
	} catch {}

	const branchAlreadyExists = await branchExists(repo, effectiveBranch);

	if (branchAlreadyExists) {
		console.log(`   Branch '${effectiveBranch}' already exists.`);
		const confirmed = await confirm(`   Reuse existing branch?`);
		if (!confirmed) {
			console.error("   Aborted. Specify a different branch with -b");
			process.exit(1);
		}
		await $`git -C ${repo} worktree add ${worktreePath} ${effectiveBranch}`;
	} else {
		const defaultBranch = await getDefaultBranch(repo);
		console.log(`   Creating new branch from origin/${defaultBranch}...`);
		const worktreeParent = join(`${repo}.worktrees`);
		if (!existsSync(worktreeParent))
			mkdirSync(worktreeParent, { recursive: true });
		await $`git -C ${repo} worktree add -b ${effectiveBranch} ${worktreePath} origin/${defaultBranch}`;
	}

	const ralphDir = join(worktreePath, ".ralph");
	if (!existsSync(ralphDir)) mkdirSync(ralphDir, { recursive: true });

	const targetPromptPath = join(ralphDir, "ralph-prompt.md");
	copyFileSync(promptFilePath, targetPromptPath);
	console.log(`   Copied prompt to .ralph/ralph-prompt.md`);

	let finalTasksFile: string | null = null;
	if (tasksFilePath && existsSync(tasksFilePath)) {
		const targetTasksPath = join(worktreePath, tasksFilePath);
		const targetTasksDir = join(
			worktreePath,
			...tasksFilePath.split("/").slice(0, -1),
		);
		if (targetTasksDir && !existsSync(targetTasksDir))
			mkdirSync(targetTasksDir, { recursive: true });
		copyFileSync(tasksFilePath, targetTasksPath);
		console.log(`   Copied tasks to ${tasksFilePath}`);
		finalTasksFile = tasksFilePath;
	}

	console.log(`   ✅ Worktree ready`);

	return {
		worktreePath,
		promptFile: ".ralph/ralph-prompt.md",
		tasksFile: finalTasksFile,
	};
}
