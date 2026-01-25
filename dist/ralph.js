#!/usr/bin/env bun
// @bun

// ralph.ts
var {$ } = globalThis.Bun;
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, copyFileSync } from "fs";
import { join } from "path";
var VERSION = "2.0.0";
var workspaceRoot = process.cwd();
var structuredTasksFile = null;
var milestoneFilter = null;
var logFilePath = null;
var getStateDir = () => join(workspaceRoot, ".ralph");
var getStatePath = () => join(getStateDir(), "ralph-loop.state.json");
var getContextPath = () => join(getStateDir(), "ralph-context.md");
var getHistoryPath = () => join(getStateDir(), "ralph-history.json");
var getTasksPath = () => join(getStateDir(), "ralph-tasks.md");
var getSuggestedTasksPath = () => join(getStateDir(), "suggested-tasks.md");
var getLogDir = () => join(getStateDir(), "logs");
var AGENTS = {
  opencode: {
    type: "opencode",
    command: "opencode",
    buildArgs: (promptText, modelName) => {
      const args = ["run"];
      if (modelName)
        args.push("-m", modelName);
      args.push(promptText);
      return args;
    },
    buildEnv: (options) => {
      const env = { ...process.env };
      if (options.filterPlugins || options.allowAllPermissions) {
        env.OPENCODE_CONFIG = ensureRalphConfig(options);
      }
      return env;
    },
    parseToolOutput: (line) => {
      const match = stripAnsi(line).match(/^\|\s{2}([A-Za-z0-9_-]+)/);
      return match ? match[1] : null;
    },
    configName: "OpenCode"
  },
  "claude-code": {
    type: "claude-code",
    command: "claude",
    buildArgs: (promptText, modelName, options) => {
      const args = ["-p", promptText];
      if (modelName)
        args.push("--model", modelName);
      if (options?.allowAllPermissions)
        args.push("--dangerously-skip-permissions");
      return args;
    },
    buildEnv: () => ({ ...process.env }),
    parseToolOutput: (line) => {
      const match = stripAnsi(line).match(/(?:Using|Called|Tool:)\s+([A-Za-z0-9_-]+)/i);
      return match ? match[1] : null;
    },
    configName: "Claude Code"
  },
  codex: {
    type: "codex",
    command: "codex",
    buildArgs: (promptText, modelName, options) => {
      const args = ["exec"];
      if (modelName)
        args.push("--model", modelName);
      if (options?.allowAllPermissions)
        args.push("--full-auto");
      args.push(promptText);
      return args;
    },
    buildEnv: () => ({ ...process.env }),
    parseToolOutput: (line) => {
      const match = stripAnsi(line).match(/(?:Tool:|Using|Calling|Running)\s+([A-Za-z0-9_-]+)/i);
      return match ? match[1] : null;
    },
    configName: "Codex"
  }
};
function parseArgs(argv) {
  const result = { command: "run", args: [], flags: {} };
  const commands = ["run", "status", "context", "tasks"];
  if (argv.length > 0 && commands.includes(argv[0])) {
    result.command = argv[0];
    argv = argv.slice(1);
  }
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      result.flags.help = true;
    } else if (arg === "-V" || arg === "--version") {
      result.flags.version = true;
    } else if (arg === "-f" || arg === "--prompt") {
      result.flags.prompt = argv[++i] || "";
    } else if (arg === "-n" || arg === "--iterations") {
      result.flags.iterations = argv[++i] || "0";
    } else if (arg === "-m" || arg === "--model") {
      result.flags.model = argv[++i] || "";
    } else if (arg === "-a" || arg === "--agent") {
      result.flags.agent = argv[++i] || "";
    } else if (arg === "-t" || arg === "--tasks-file") {
      result.flags.tasksFile = argv[++i] || "";
    } else if (arg === "-M" || arg === "--milestone") {
      result.flags.milestone = argv[++i] || "";
    } else if (arg === "-w" || arg === "--workspace") {
      result.flags.workspace = argv[++i] || "";
    } else if (arg === "--repo") {
      result.flags.repo = argv[++i] || "";
    } else if (arg === "-b" || arg === "--branch") {
      result.flags.branch = argv[++i] || "";
    } else if (arg === "--done") {
      result.flags.done = argv[++i] || "";
    } else if (arg === "--next") {
      result.flags.next = argv[++i] || "";
    } else if (arg === "--timeout") {
      result.flags.timeout = argv[++i] || "30";
    } else if (arg === "--force") {
      result.flags.force = true;
    } else if (arg === "-v" || arg === "--verbose") {
      result.flags.verbose = true;
    } else if (arg === "-q" || arg === "--quiet") {
      result.flags.quiet = true;
    } else if (arg === "--no-commit") {
      result.flags.noCommit = true;
    } else if (arg === "-i" || arg === "--interactive") {
      result.flags.interactive = true;
    } else if (arg === "--no-plugins") {
      result.flags.noPlugins = true;
    } else if (arg === "--log") {
      result.flags.log = true;
    } else if (arg === "--clear") {
      result.flags.clear = true;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      console.error(`Run 'ralph --help' for usage`);
      process.exit(1);
    } else {
      result.args.push(arg);
    }
    i++;
  }
  return result;
}
var HELP_MAIN = `
Ralph Wiggum Loop v${VERSION} - Iterative AI development

Usage:
  ralph [command] [options]

Commands:
  run              Start the loop (default)
  status           Show loop status and history  
  context <text>   Add context for next iteration
  tasks            List/manage tasks

Run 'ralph <command> --help' for command-specific help.

Examples:
  ralph run -f prompt.md -t docs/tasks.md -M M2b
  ralph status
  ralph context "focus on the auth module"
  ralph tasks add "fix the login bug"
`;
var HELP_RUN = `
ralph run - Start the iterative loop

Usage:
  ralph run [options] [prompt]
  ralph -f <file> [options]

Core Options:
  -f, --prompt <file>     Prompt file path
  -n, --iterations <n>    Max iterations (0=unlimited, default: 0)
  -m, --model <name>      Model to use (default: anthropic/claude-sonnet-4-5)
  -a, --agent <type>      Agent: opencode (default), claude-code, codex

Tasks:
  -t, --tasks-file <path> Structured tasks file (e.g., docs/tasks.md)  
  -M, --milestone <name>  Filter by milestone (e.g., M2b)
  --done <phrase>         Completion promise (default: COMPLETE)
  --next <phrase>         Task promise (default: READY_FOR_NEXT_TASK)

Workspace:
  -w, --workspace <dir>   Working directory (default: current)
  --repo <path>           Git repo for worktree creation
  -b, --branch <name>     Branch name for worktree

Behavior:
  --timeout <mins>        Inactivity timeout (default: 30, 0=disable)
  --force                 Clear stale state and start fresh
  -v, --verbose           Verbose tool output
  -q, --quiet             Buffer output (no streaming)
  --no-commit             Disable auto-commit after iterations
  -i, --interactive       Require permission prompts (default: auto-approve)
  --no-plugins            Disable non-auth plugins (opencode only)
  --log                   Log output to .ralph/logs/

Examples:
  ralph run -f prompt.md -t docs/tasks.md -M M2b -n 50
  ralph run "Fix the auth bug" --timeout 15
  ralph run -f prompt.md --force --log
`;
var HELP_STATUS = `
ralph status - Show loop status and history

Usage:
  ralph status [options]

Options:
  -w, --workspace <dir>   Check status in different directory

Examples:
  ralph status
  ralph status -w ~/projects/my-app
`;
var HELP_CONTEXT = `
ralph context - Add context for next iteration

Usage:
  ralph context <text>    Add context text
  ralph context --clear   Clear pending context

Options:
  -w, --workspace <dir>   Target different directory

Examples:
  ralph context "Focus on the auth module first"
  ralph context --clear
`;
var HELP_TASKS = `
ralph tasks - List and manage tasks

Usage:
  ralph tasks             List all tasks
  ralph tasks add <desc>  Add a new task
  ralph tasks rm <n>      Remove task by index

Options:
  -w, --workspace <dir>   Target different directory
  -t, --tasks-file <path> Specify tasks file

Examples:
  ralph tasks
  ralph tasks add "implement user login"
  ralph tasks rm 3
`;
function stripAnsi(input) {
  return input.replace(/\x1B\[[0-9;]*m/g, "");
}
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
function formatDurationLong(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0)
    return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0)
    return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function loadState() {
  const path = getStatePath();
  if (!existsSync(path))
    return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
function saveState(state) {
  const dir = getStateDir();
  if (!existsSync(dir))
    mkdirSync(dir, { recursive: true });
  writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}
function clearState() {
  const path = getStatePath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
function loadHistory() {
  const path = getHistoryPath();
  if (!existsSync(path)) {
    return {
      iterations: [],
      totalDurationMs: 0,
      struggleIndicators: { repeatedErrors: {}, noProgressIterations: 0, shortIterations: 0 }
    };
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {
      iterations: [],
      totalDurationMs: 0,
      struggleIndicators: { repeatedErrors: {}, noProgressIterations: 0, shortIterations: 0 }
    };
  }
}
function saveHistory(history) {
  const dir = getStateDir();
  if (!existsSync(dir))
    mkdirSync(dir, { recursive: true });
  writeFileSync(getHistoryPath(), JSON.stringify(history, null, 2));
}
function clearHistory() {
  const path = getHistoryPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
function loadContext() {
  const path = getContextPath();
  if (!existsSync(path))
    return null;
  try {
    const content = readFileSync(path, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}
function clearContext() {
  const path = getContextPath();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
function parseTasks(content) {
  const tasks = [];
  const lines = content.split(`
`);
  let currentTask = null;
  for (const line of lines) {
    const topLevelMatch = line.match(/^- \[([ x\/])\]\s*(.+)/);
    if (topLevelMatch) {
      if (currentTask)
        tasks.push(currentTask);
      const [, statusChar, text] = topLevelMatch;
      let status = "todo";
      if (statusChar === "x")
        status = "complete";
      else if (statusChar === "/")
        status = "in-progress";
      currentTask = { text, status, subtasks: [], originalLine: line };
      continue;
    }
    const subtaskMatch = line.match(/^\s+- \[([ x\/])\]\s*(.+)/);
    if (subtaskMatch && currentTask) {
      const [, statusChar, text] = subtaskMatch;
      let status = "todo";
      if (statusChar === "x")
        status = "complete";
      else if (statusChar === "/")
        status = "in-progress";
      currentTask.subtasks.push({ text, status, subtasks: [], originalLine: line });
    }
  }
  if (currentTask)
    tasks.push(currentTask);
  return tasks;
}
function parseStructuredTasks(content) {
  const milestones = new Map;
  const allTasks = new Map;
  const lines = content.split(`
`);
  let currentMilestone = null;
  let currentTask = null;
  let taskLines = [];
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
    const taskMatch = line.match(/^-\s+\[([ x\/])\]\s+([a-zA-Z0-9_-]+):\s*(.+)$/);
    if (taskMatch) {
      saveCurrentTask();
      const [, statusChar, id, title] = taskMatch;
      let status = "todo";
      if (statusChar === "x")
        status = "complete";
      else if (statusChar === "/")
        status = "in-progress";
      currentTask = {
        id,
        title,
        milestone: currentMilestone,
        status,
        depends: [],
        verify: null,
        started: null,
        completed: null,
        originalLines: []
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
        continue;
      }
    }
  }
  saveCurrentTask();
  return { milestones, allTasks };
}
function loadStructuredTasks() {
  if (!structuredTasksFile)
    return null;
  const fullPath = join(workspaceRoot, structuredTasksFile);
  if (!existsSync(fullPath))
    return null;
  try {
    return parseStructuredTasks(readFileSync(fullPath, "utf-8"));
  } catch {
    return null;
  }
}
function getNextStructuredTask(milestone) {
  const data = loadStructuredTasks();
  if (!data)
    return null;
  let tasks;
  if (milestone) {
    tasks = data.milestones.get(milestone) || [];
  } else {
    tasks = Array.from(data.allTasks.values());
  }
  for (const task of tasks) {
    if (task.status !== "todo" && task.status !== "in-progress")
      continue;
    const allDepsComplete = task.depends.every((depId) => {
      const dep = data.allTasks.get(depId);
      return dep?.status === "complete";
    });
    if (allDepsComplete)
      return task;
  }
  return null;
}
function allStructuredTasksComplete(milestone) {
  const data = loadStructuredTasks();
  if (!data)
    return false;
  let tasks;
  if (milestone) {
    tasks = data.milestones.get(milestone) || [];
  } else {
    tasks = Array.from(data.allTasks.values());
  }
  return tasks.length > 0 && tasks.every((t) => t.status === "complete");
}
function getStructuredTasksSummary(milestone) {
  const data = loadStructuredTasks();
  if (!data)
    return { pending: 0, inProgress: 0, completed: 0, total: 0 };
  let tasks;
  if (milestone) {
    tasks = data.milestones.get(milestone) || [];
  } else {
    tasks = Array.from(data.allTasks.values());
  }
  const pending = tasks.filter((t) => t.status === "todo").length;
  const inProgress = tasks.filter((t) => t.status === "in-progress").length;
  const completed = tasks.filter((t) => t.status === "complete").length;
  return { pending, inProgress, completed, total: tasks.length };
}
function loadPluginsFromConfig(configPath) {
  if (!existsSync(configPath))
    return [];
  try {
    const raw = readFileSync(configPath, "utf-8");
    const withoutBlock = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const withoutLine = withoutBlock.replace(/^\s*\/\/.*$/gm, "");
    const parsed = JSON.parse(withoutLine);
    const plugins = parsed?.plugin;
    return Array.isArray(plugins) ? plugins.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}
function ensureRalphConfig(options) {
  const stateDir = getStateDir();
  if (!existsSync(stateDir))
    mkdirSync(stateDir, { recursive: true });
  const configPath = join(stateDir, "ralph-opencode.config.json");
  const userConfigPath = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"), "opencode", "opencode.json");
  const projectConfigPath = join(process.cwd(), ".ralph", "opencode.json");
  const legacyProjectConfigPath = join(process.cwd(), ".opencode", "opencode.json");
  const config = { $schema: "https://opencode.ai/config.json" };
  if (options.filterPlugins) {
    const plugins = [
      ...loadPluginsFromConfig(userConfigPath),
      ...loadPluginsFromConfig(projectConfigPath),
      ...loadPluginsFromConfig(legacyProjectConfigPath)
    ];
    config.plugin = Array.from(new Set(plugins)).filter((p) => /auth/i.test(p));
  }
  if (options.allowAllPermissions) {
    config.permission = {
      read: "allow",
      edit: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      bash: "allow",
      task: "allow",
      webfetch: "allow",
      websearch: "allow",
      codesearch: "allow",
      todowrite: "allow",
      todoread: "allow",
      question: "allow",
      lsp: "allow",
      external_directory: "allow"
    };
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
function extractWorktreeName(promptContent) {
  const match = promptContent.match(/^#\s+(.+)$/m);
  if (!match) {
    console.error("Error: No # heading found in prompt file.");
    process.exit(1);
  }
  return match[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
async function branchExists(repoDir, branch) {
  try {
    const localResult = await $`git -C ${repoDir} branch --list ${branch}`.text();
    if (localResult.trim())
      return true;
    const remoteResult = await $`git -C ${repoDir} branch -r --list origin/${branch}`.text();
    return !!remoteResult.trim();
  } catch {
    return false;
  }
}
async function getDefaultBranch(repoDir) {
  try {
    const result = await $`git -C ${repoDir} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`.text();
    const match = result.match(/refs\/remotes\/origin\/(.+)/);
    if (match)
      return match[1].trim();
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
async function confirm(message) {
  process.stdout.write(`${message} [y/N] `);
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const answer = new TextDecoder().decode(value).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
async function setupWorktree(repo, promptContent, branch, promptFilePath, tasksFilePath) {
  if (!existsSync(join(repo, ".git"))) {
    console.error(`Error: Not a git repository: ${repo}`);
    process.exit(1);
  }
  const worktreeName = extractWorktreeName(promptContent);
  const worktreePath = `${repo}.worktrees/${worktreeName}`;
  const effectiveBranch = branch || worktreeName;
  console.log(`
\uD83D\uDCC1 Worktree Setup`);
  console.log(`   Name: ${worktreeName}`);
  console.log(`   Path: ${worktreePath}`);
  console.log(`   Branch: ${effectiveBranch}`);
  if (existsSync(worktreePath)) {
    console.log(`   Status: Using existing worktree`);
    return {
      worktreePath,
      promptFile: join(worktreePath, ".ralph", "ralph-prompt.md"),
      tasksFile: tasksFilePath
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
    const worktreeParent = join(repo + ".worktrees");
    if (!existsSync(worktreeParent))
      mkdirSync(worktreeParent, { recursive: true });
    await $`git -C ${repo} worktree add -b ${effectiveBranch} ${worktreePath} origin/${defaultBranch}`;
  }
  const ralphDir = join(worktreePath, ".ralph");
  if (!existsSync(ralphDir))
    mkdirSync(ralphDir, { recursive: true });
  const targetPromptPath = join(ralphDir, "ralph-prompt.md");
  copyFileSync(promptFilePath, targetPromptPath);
  console.log(`   Copied prompt to .ralph/ralph-prompt.md`);
  let finalTasksFile = null;
  if (tasksFilePath && existsSync(tasksFilePath)) {
    const targetTasksPath = join(worktreePath, tasksFilePath);
    const targetTasksDir = join(worktreePath, ...tasksFilePath.split("/").slice(0, -1));
    if (targetTasksDir && !existsSync(targetTasksDir))
      mkdirSync(targetTasksDir, { recursive: true });
    copyFileSync(tasksFilePath, targetTasksPath);
    console.log(`   Copied tasks to ${tasksFilePath}`);
    finalTasksFile = tasksFilePath;
  }
  console.log(`   \u2705 Worktree ready`);
  return { worktreePath, promptFile: ".ralph/ralph-prompt.md", tasksFile: finalTasksFile };
}
function initLogFile() {
  if (!logFilePath)
    return;
  const logDir = getLogDir();
  if (!existsSync(logDir))
    mkdirSync(logDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const milestone = milestoneFilter || "all";
  logFilePath = join(logDir, `${milestone}-${timestamp}.log`);
  writeFileSync(logFilePath, `==========================================
Ralph Wiggum Session Log
==========================================
Started:      ${new Date().toLocaleString()}
Milestone:    ${milestoneFilter || "ALL"}
Working Dir:  ${workspaceRoot}
Tasks File:   ${structuredTasksFile || "N/A"}
==========================================

`);
}
function parseSuggestedTasks(output) {
  const suggestions = [];
  const regex = /<suggest-task(?:\s+milestone="([^"]*)")?\s*>([\s\S]*?)<\/suggest-task>/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const milestone = match[1] || null;
    const task = match[2].trim();
    if (task)
      suggestions.push({ task, milestone });
  }
  return suggestions;
}
function appendSuggestedTasks(suggestions, iteration) {
  if (suggestions.length === 0)
    return;
  const suggestedPath = getSuggestedTasksPath();
  const timestamp = new Date().toISOString();
  let content = "";
  if (existsSync(suggestedPath)) {
    content = readFileSync(suggestedPath, "utf-8");
  } else {
    content = `# Suggested Tasks

Tasks suggested by the Ralph loop agent for review.

`;
  }
  content += `
## From Iteration ${iteration} (${timestamp})

`;
  for (const { task, milestone } of suggestions) {
    if (milestone) {
      content += `- [ ] ${task}
  - suggested-milestone: ${milestone}
`;
    } else {
      content += `- [ ] ${task}
`;
    }
  }
  writeFileSync(suggestedPath, content);
  console.log(`\uD83D\uDCDD ${suggestions.length} task suggestion(s) written to .ralph/suggested-tasks.md`);
}
function buildPrompt(state, _agent) {
  const context = loadContext();
  const contextSection = context ? `
## Additional Context (added by user mid-loop)

${context}

---
` : "";
  if (state.structuredTasksFile) {
    const summary = getStructuredTasksSummary(state.milestoneFilter);
    const nextTask = getNextStructuredTask(state.milestoneFilter);
    const allComplete = allStructuredTasksComplete(state.milestoneFilter);
    const data = loadStructuredTasks();
    let tasks = [];
    if (data) {
      if (state.milestoneFilter) {
        tasks = data.milestones.get(state.milestoneFilter) || [];
      } else {
        tasks = Array.from(data.allTasks.values());
      }
    }
    const taskList = tasks.map((t) => {
      const statusIcon = t.status === "complete" ? "\u2705" : t.status === "in-progress" ? "\uD83D\uDD04" : "\u23F8\uFE0F";
      const deps = t.depends.length ? ` (depends: ${t.depends.join(", ")})` : "";
      return `${statusIcon} ${t.id}: ${t.title}${deps}`;
    }).join(`
`);
    let taskInstructions = "";
    if (allComplete) {
      taskInstructions = `
\u2705 ALL TASKS COMPLETE!
   Output <promise>${state.completionPromise}</promise> to finish.`;
    } else if (nextTask) {
      taskInstructions = `
\uD83D\uDCCD NEXT TASK: ${nextTask.id}
   Title: "${nextTask.title}"
   ${nextTask.verify ? `Verify: \`${nextTask.verify}\`` : ""}
   ${nextTask.depends.length ? `Dependencies: ${nextTask.depends.join(", ")} (all completed)` : ""}
   
   1. Change [ ] to [/] for this task in ${state.structuredTasksFile}
   2. Add "- started: ${new Date().toISOString()}" under the task
   3. Complete the work
   4. Run verification: ${nextTask.verify || "(no verification command)"}
   5. Change [/] to [x] and add "- completed: <timestamp>"
   6. Commit changes
   7. Output <promise>${state.taskPromise}</promise>`;
    } else {
      taskInstructions = `
\u23F3 No available tasks. Check dependencies - some tasks may be blocked.`;
    }
    return `
# Ralph Wiggum Loop - Iteration ${state.iteration}

You are in an iterative development loop working through a structured task list.
${contextSection}
## STRUCTURED TASKS MODE: ${state.milestoneFilter ? `Milestone ${state.milestoneFilter}` : "All Tasks"}

**Summary:** ${summary.completed}/${summary.total} complete, ${summary.inProgress} in progress, ${summary.pending} pending

**Tasks:**
${taskList}
${taskInstructions}

## Your Main Goal

${state.prompt}

## Critical Rules

- Work on ONE task at a time from ${state.structuredTasksFile}
- When starting a task: change [ ] to [/] and add "- started: <ISO timestamp>"
- When completing a task: change [/] to [x] and add "- completed: <ISO timestamp>"
- Run the verification command in the task's "verify" field before marking complete
- Commit your changes after completing each task
- ONLY output <promise>${state.taskPromise}</promise> when the current task is verified complete
- ONLY output <promise>${state.completionPromise}</promise> when ALL tasks for milestone ${state.milestoneFilter || "ALL"} are complete
- Do NOT lie or output false promises to exit the loop
- If stuck, try a different approach

## Performance Tips

- Use grep/ripgrep directly for searches - do NOT use the Task tool for simple find/search operations
- Prefer Bash commands over spawning sub-agents
- Keep iterations fast - avoid unnecessary tool calls

## Suggesting New Tasks

If you discover work that should be done but isn't in the task list, suggest it:

\`\`\`
<suggest-task>Description of the task that should be added</suggest-task>
<suggest-task milestone="M2b">Task for a specific milestone</suggest-task>
\`\`\`

## Current Iteration: ${state.iteration}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : " (unlimited)"}

Now, work on the current task. Good luck!
`.trim();
  }
  return `
# Ralph Wiggum Loop - Iteration ${state.iteration}

You are in an iterative development loop. Work on the task below until you can genuinely complete it.
${contextSection}
## Your Task

${state.prompt}

## Instructions

1. Read the current state of files to understand what's been done
2. Track your progress and plan remaining work
3. Make progress on the task
4. Run tests/verification if applicable
5. When the task is GENUINELY COMPLETE, output:
   <promise>${state.completionPromise}</promise>

## Critical Rules

- ONLY output <promise>${state.completionPromise}</promise> when the task is truly done
- Do NOT lie or output false promises to exit the loop
- If stuck, try a different approach
- Check your work before claiming completion
- The loop will continue until you succeed

## Current Iteration: ${state.iteration}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : " (unlimited)"}

Now, work on the task. Good luck!
`.trim();
}
function formatToolSummary(toolCounts, maxItems = 6) {
  if (!toolCounts.size)
    return "";
  const entries = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, maxItems);
  const remaining = entries.length - shown.length;
  const parts = shown.map(([name, count]) => `${name} ${count}`);
  if (remaining > 0)
    parts.push(`+${remaining} more`);
  return parts.join(" \u2022 ");
}
async function streamProcessOutput(proc, options) {
  const toolCounts = new Map;
  let stdoutText = "";
  let stderrText = "";
  let lastPrintedAt = Date.now();
  let lastActivityAt = Date.now();
  let lastToolSummaryAt = 0;
  let timedOut = false;
  const maybePrintToolSummary = (force = false) => {
    if (!options.compactTools || toolCounts.size === 0)
      return;
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
  const handleLine = (line, isError) => {
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
    if (isError)
      console.error(line);
    else
      console.log(line);
    lastPrintedAt = Date.now();
  };
  const streamText = async (stream, onText, isError) => {
    if (!stream)
      return;
    const reader = stream.getReader();
    const decoder = new TextDecoder;
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done)
        break;
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) {
        onText(text);
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines)
          handleLine(line, isError);
      }
    }
    const flushed = decoder.decode();
    if (flushed.length > 0) {
      onText(flushed);
      buffer += flushed;
    }
    if (buffer.length > 0)
      handleLine(buffer, isError);
  };
  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const inactivityDuration = now - lastActivityAt;
    if (options.inactivityTimeoutMs > 0 && inactivityDuration >= options.inactivityTimeoutMs) {
      timedOut = true;
      console.log(`
\u23F0 INACTIVITY TIMEOUT: No output for ${formatDuration(inactivityDuration)}. Killing process...`);
      try {
        proc.kill();
      } catch {}
      return;
    }
    if (now - lastPrintedAt >= options.heartbeatIntervalMs) {
      const elapsed = formatDuration(now - options.iterationStart);
      const sinceActivity = formatDuration(now - lastActivityAt);
      const timeoutIn = options.inactivityTimeoutMs > 0 ? ` \xB7 timeout in ${formatDuration(options.inactivityTimeoutMs - inactivityDuration)}` : "";
      console.log(`\u23F3 working... elapsed ${elapsed} \xB7 last activity ${sinceActivity} ago${timeoutIn}`);
      lastPrintedAt = now;
    }
  }, options.heartbeatIntervalMs);
  try {
    await Promise.all([
      streamText(proc.stdout, (chunk) => {
        stdoutText += chunk;
      }, false),
      streamText(proc.stderr, (chunk) => {
        stderrText += chunk;
      }, true)
    ]);
  } finally {
    clearInterval(heartbeatTimer);
  }
  if (options.compactTools)
    maybePrintToolSummary(true);
  return { stdoutText, stderrText, toolCounts, timedOut };
}
async function captureFileSnapshot() {
  const files = new Map;
  try {
    const status = await $`git status --porcelain`.text();
    const modifiedFiles = [];
    for (const line of status.split(`
`)) {
      if (line.trim())
        modifiedFiles.push(line.substring(3).trim());
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
function getModifiedFilesSinceSnapshot(before, after) {
  const changedFiles = [];
  for (const [file, hash] of after.files) {
    if (before.files.get(file) !== hash)
      changedFiles.push(file);
  }
  for (const [file] of before.files) {
    if (!after.files.has(file))
      changedFiles.push(file);
  }
  return changedFiles;
}
function extractErrors(output) {
  const errors = [];
  const lines = output.split(`
`);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("error:") || lower.includes("failed:") || lower.includes("exception:") || lower.includes("typeerror") || lower.includes("syntaxerror") || lower.includes("referenceerror") || lower.includes("test") && lower.includes("fail")) {
      const cleaned = line.trim().substring(0, 200);
      if (cleaned && !errors.includes(cleaned))
        errors.push(cleaned);
    }
  }
  return errors.slice(0, 10);
}
function cmdStatus(flags) {
  if (flags.workspace)
    workspaceRoot = flags.workspace;
  const state = loadState();
  const history = loadHistory();
  const context = loadContext();
  console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551                    Ralph Wiggum Status                           \u2551
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D
`);
  if (state?.active) {
    const elapsed = Date.now() - new Date(state.startedAt).getTime();
    console.log(`\uD83D\uDD04 ACTIVE LOOP`);
    console.log(`   Iteration:    ${state.iteration}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : " (unlimited)"}`);
    console.log(`   Started:      ${state.startedAt}`);
    console.log(`   Elapsed:      ${formatDurationLong(elapsed)}`);
    console.log(`   Promise:      ${state.completionPromise}`);
    const agentLabel = state.agent ? AGENTS[state.agent]?.configName ?? state.agent : "OpenCode";
    console.log(`   Agent:        ${agentLabel}`);
    if (state.model)
      console.log(`   Model:        ${state.model}`);
    if (state.structuredTasksFile) {
      console.log(`   Tasks File:   ${state.structuredTasksFile}`);
      if (state.milestoneFilter)
        console.log(`   Milestone:    ${state.milestoneFilter}`);
    }
  } else {
    console.log(`\u23F9\uFE0F  No active loop`);
  }
  if (context) {
    console.log(`
\uD83D\uDCDD PENDING CONTEXT:`);
    console.log(`   ${context.split(`
`).join(`
   `)}`);
  }
  if (history.iterations.length > 0) {
    console.log(`
\uD83D\uDCCA HISTORY (${history.iterations.length} iterations)`);
    console.log(`   Total time: ${formatDurationLong(history.totalDurationMs)}`);
    const recent = history.iterations.slice(-5);
    console.log(`
   Recent:`);
    for (const iter of recent) {
      const tools = Object.entries(iter.toolsUsed).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(" ");
      const status = iter.completionDetected ? "\u2705" : iter.exitCode !== 0 ? "\u274C" : "\uD83D\uDD04";
      console.log(`   ${status} #${iter.iteration}: ${formatDurationLong(iter.durationMs)} | ${tools || "no tools"}`);
    }
  }
  console.log("");
}
function cmdContext(args, flags) {
  if (flags.workspace)
    workspaceRoot = flags.workspace;
  if (flags.clear) {
    if (existsSync(getContextPath())) {
      unlinkSync(getContextPath());
      console.log(`\u2705 Context cleared`);
    } else {
      console.log(`\u2139\uFE0F  No pending context to clear`);
    }
    return;
  }
  const contextText = args.join(" ");
  if (!contextText) {
    console.error("Error: No context text provided");
    console.error("Usage: ralph context <text>");
    console.error("       ralph context --clear");
    process.exit(1);
  }
  const stateDir = getStateDir();
  if (!existsSync(stateDir))
    mkdirSync(stateDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const newEntry = `
## Context added at ${timestamp}
${contextText}
`;
  const contextPath = getContextPath();
  if (existsSync(contextPath)) {
    const existing = readFileSync(contextPath, "utf-8");
    writeFileSync(contextPath, existing + newEntry);
  } else {
    writeFileSync(contextPath, `# Ralph Loop Context
${newEntry}`);
  }
  console.log(`\u2705 Context added for next iteration`);
  const state = loadState();
  if (state?.active) {
    console.log(`   Will be picked up in iteration ${state.iteration + 1}`);
  }
}
function cmdTasks(args, flags) {
  if (flags.workspace)
    workspaceRoot = flags.workspace;
  if (flags.tasksFile)
    structuredTasksFile = flags.tasksFile;
  const subcommand = args[0] || "list";
  if (subcommand === "add") {
    const desc = args.slice(1).join(" ");
    if (!desc) {
      console.error("Error: No task description");
      console.error("Usage: ralph tasks add <description>");
      process.exit(1);
    }
    const tasksPath2 = getTasksPath();
    const stateDir = getStateDir();
    if (!existsSync(stateDir))
      mkdirSync(stateDir, { recursive: true });
    let content2 = "";
    if (existsSync(tasksPath2)) {
      content2 = readFileSync(tasksPath2, "utf-8");
    } else {
      content2 = `# Ralph Tasks

`;
    }
    writeFileSync(tasksPath2, content2.trimEnd() + `
` + `- [ ] ${desc}
`);
    console.log(`\u2705 Task added: "${desc}"`);
    return;
  }
  if (subcommand === "rm") {
    const indexStr = args[1];
    if (!indexStr || isNaN(parseInt(indexStr))) {
      console.error("Error: Invalid task index");
      console.error("Usage: ralph tasks rm <index>");
      process.exit(1);
    }
    const taskIndex = parseInt(indexStr);
    const tasksPath2 = getTasksPath();
    if (!existsSync(tasksPath2)) {
      console.error("Error: No tasks file found");
      process.exit(1);
    }
    const content2 = readFileSync(tasksPath2, "utf-8");
    const tasks2 = parseTasks(content2);
    if (taskIndex < 1 || taskIndex > tasks2.length) {
      console.error(`Error: Index ${taskIndex} out of range (1-${tasks2.length})`);
      process.exit(1);
    }
    const lines = content2.split(`
`);
    const newLines = [];
    let inRemovedTask = false;
    let currentTaskLine = 0;
    for (const line of lines) {
      if (line.match(/^- \[/)) {
        currentTaskLine++;
        if (currentTaskLine === taskIndex) {
          inRemovedTask = true;
          continue;
        } else {
          inRemovedTask = false;
        }
      }
      if (inRemovedTask && line.match(/^\s+/) && line.trim() !== "")
        continue;
      newLines.push(line);
    }
    writeFileSync(tasksPath2, newLines.join(`
`));
    console.log(`\u2705 Removed task ${taskIndex}`);
    return;
  }
  if (structuredTasksFile) {
    const data = loadStructuredTasks();
    if (data) {
      console.log(`Structured Tasks:
`);
      for (const [milestone, tasks2] of data.milestones) {
        const complete = tasks2.filter((t) => t.status === "complete").length;
        console.log(`## ${milestone} (${complete}/${tasks2.length})`);
        for (const task of tasks2) {
          const icon = task.status === "complete" ? "\u2705" : task.status === "in-progress" ? "\uD83D\uDD04" : "\u23F8\uFE0F";
          console.log(`   ${icon} ${task.id}: ${task.title}`);
        }
        console.log("");
      }
      return;
    }
  }
  const tasksPath = getTasksPath();
  if (!existsSync(tasksPath)) {
    console.log("No tasks file found.");
    console.log("Use 'ralph tasks add <description>' to create tasks.");
    return;
  }
  const content = readFileSync(tasksPath, "utf-8");
  const tasks = parseTasks(content);
  if (tasks.length === 0) {
    console.log("No tasks found.");
    return;
  }
  console.log(`Tasks:
`);
  for (let i = 0;i < tasks.length; i++) {
    const task = tasks[i];
    const icon = task.status === "complete" ? "\u2705" : task.status === "in-progress" ? "\uD83D\uDD04" : "\u23F8\uFE0F";
    console.log(`${i + 1}. ${icon} ${task.text}`);
    for (const sub of task.subtasks) {
      const subIcon = sub.status === "complete" ? "\u2705" : sub.status === "in-progress" ? "\uD83D\uDD04" : "\u23F8\uFE0F";
      console.log(`      ${subIcon} ${sub.text}`);
    }
  }
}
async function cmdRun(args, flags) {
  const opts = {
    prompt: "",
    promptFile: flags.prompt || "",
    model: flags.model || "anthropic/claude-sonnet-4-5",
    agent: flags.agent || "opencode",
    iterations: parseInt(flags.iterations || "0") || 0,
    tasksFile: flags.tasksFile || null,
    milestone: flags.milestone || null,
    workspace: flags.workspace || process.cwd(),
    repo: flags.repo || null,
    branch: flags.branch || null,
    done: flags.done || "COMPLETE",
    next: flags.next || "READY_FOR_NEXT_TASK",
    timeout: parseInt(flags.timeout || "30") || 30,
    force: !!flags.force,
    verbose: !!flags.verbose,
    quiet: !!flags.quiet,
    noCommit: !!flags.noCommit,
    interactive: !!flags.interactive,
    noPlugins: !!flags.noPlugins,
    log: !!flags.log
  };
  workspaceRoot = opts.workspace;
  structuredTasksFile = opts.tasksFile;
  milestoneFilter = opts.milestone;
  if (opts.promptFile) {
    if (!existsSync(opts.promptFile)) {
      console.error(`Error: Prompt file not found: ${opts.promptFile}`);
      process.exit(1);
    }
    opts.prompt = readFileSync(opts.promptFile, "utf-8");
  } else if (args.length > 0) {
    if (args.length === 1 && existsSync(args[0])) {
      opts.promptFile = args[0];
      opts.prompt = readFileSync(args[0], "utf-8");
    } else {
      opts.prompt = args.join(" ");
    }
  }
  if (!opts.prompt) {
    console.error("Error: No prompt provided");
    console.error("Usage: ralph run -f <file> [options]");
    console.error("       ralph run <prompt> [options]");
    process.exit(1);
  }
  if (opts.repo) {
    if (!opts.promptFile) {
      console.error("Error: --repo requires -f <prompt-file>");
      process.exit(1);
    }
    const result = await setupWorktree(opts.repo, opts.prompt, opts.branch, opts.promptFile, opts.tasksFile);
    workspaceRoot = result.worktreePath;
    opts.workspace = result.worktreePath;
    if (result.tasksFile)
      structuredTasksFile = result.tasksFile;
    const newPromptPath = join(workspaceRoot, result.promptFile);
    if (existsSync(newPromptPath)) {
      opts.prompt = readFileSync(newPromptPath, "utf-8");
    }
  }
  const agentConfig = AGENTS[opts.agent];
  if (!agentConfig) {
    console.error(`Error: Unknown agent: ${opts.agent}`);
    console.error("Available: opencode, claude-code, codex");
    process.exit(1);
  }
  const agentPath = Bun.which(agentConfig.command);
  if (!agentPath) {
    console.error(`Error: ${agentConfig.configName} CLI ('${agentConfig.command}') not found`);
    process.exit(1);
  }
  const existingState = loadState();
  if (existingState?.active) {
    if (opts.force) {
      console.log(`\u26A0\uFE0F  Clearing stale state from iteration ${existingState.iteration}`);
      clearState();
    } else {
      console.error(`Error: Loop already active (iteration ${existingState.iteration})`);
      console.error(`Started: ${existingState.startedAt}`);
      console.error(`Use --force to clear and restart`);
      process.exit(1);
    }
  }
  if (opts.log) {
    logFilePath = "auto";
    initLogFile();
  }
  console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551                    Ralph Wiggum Loop                            \u2551
\u2551         Iterative AI Development with ${agentConfig.configName.padEnd(20)}        \u2551
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D
`);
  const promptPreview = opts.prompt.replace(/\s+/g, " ").substring(0, 60) + (opts.prompt.length > 60 ? "..." : "");
  console.log(`Prompt:     ${promptPreview}`);
  console.log(`Agent:      ${agentConfig.configName}`);
  console.log(`Model:      ${opts.model}`);
  console.log(`Iterations: ${opts.iterations > 0 ? opts.iterations : "unlimited"}`);
  console.log(`Timeout:    ${opts.timeout > 0 ? `${opts.timeout} minutes` : "disabled"}`);
  if (opts.tasksFile) {
    console.log(`Tasks:      ${opts.tasksFile}`);
    if (opts.milestone)
      console.log(`Milestone:  ${opts.milestone}`);
    const summary = getStructuredTasksSummary(opts.milestone);
    console.log(`Progress:   ${summary.completed}/${summary.total} complete`);
  }
  console.log("");
  console.log("Starting loop... (Ctrl+C to stop)");
  console.log("\u2550".repeat(68));
  const state = {
    active: true,
    iteration: 1,
    maxIterations: opts.iterations,
    completionPromise: opts.done,
    tasksMode: !!opts.tasksFile,
    taskPromise: opts.next,
    prompt: opts.prompt,
    startedAt: new Date().toISOString(),
    model: opts.model,
    agent: opts.agent,
    workspaceRoot,
    structuredTasksFile,
    milestoneFilter,
    logFile: logFilePath
  };
  saveState(state);
  const history = {
    iterations: [],
    totalDurationMs: 0,
    struggleIndicators: { repeatedErrors: {}, noProgressIterations: 0, shortIterations: 0 }
  };
  saveHistory(history);
  let currentProc = null;
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) {
      console.log(`
Force stopping...`);
      process.exit(1);
    }
    stopping = true;
    console.log(`
Stopping Ralph loop...`);
    if (currentProc) {
      try {
        currentProc.kill();
      } catch {}
    }
    clearState();
    console.log("Loop cancelled.");
    process.exit(0);
  });
  while (true) {
    if (opts.iterations > 0 && state.iteration > opts.iterations) {
      console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557`);
      console.log(`\u2551  Max iterations (${opts.iterations}) reached`);
      console.log(`\u2551  Total time: ${formatDurationLong(history.totalDurationMs)}`);
      console.log(`\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D`);
      clearState();
      break;
    }
    const iterInfo = opts.iterations > 0 ? ` / ${opts.iterations}` : "";
    console.log(`
\uD83D\uDD04 Iteration ${state.iteration}${iterInfo}`);
    if (structuredTasksFile) {
      const summary = getStructuredTasksSummary(milestoneFilter);
      const nextTask = getNextStructuredTask(milestoneFilter);
      console.log(`   Tasks: ${summary.completed}/${summary.total} | Next: ${nextTask?.id || "NONE"}`);
    }
    console.log("\u2500".repeat(68));
    const contextAtStart = loadContext();
    const snapshotBefore = await captureFileSnapshot();
    const fullPrompt = buildPrompt(state, agentConfig);
    const iterationStart = Date.now();
    try {
      const cmdArgs = agentConfig.buildArgs(fullPrompt, opts.model, { allowAllPermissions: !opts.interactive });
      const env = agentConfig.buildEnv({ filterPlugins: opts.noPlugins, allowAllPermissions: !opts.interactive });
      currentProc = Bun.spawn([agentConfig.command, ...cmdArgs], {
        env,
        cwd: workspaceRoot,
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe"
      });
      let result = "";
      let stderr = "";
      let toolCounts = new Map;
      let timedOut = false;
      if (!opts.quiet) {
        console.log("\u23F3 Starting agent...");
        const streamed = await streamProcessOutput(currentProc, {
          compactTools: !opts.verbose,
          toolSummaryIntervalMs: 3000,
          heartbeatIntervalMs: 1e4,
          iterationStart,
          agent: agentConfig,
          inactivityTimeoutMs: opts.timeout * 60 * 1000
        });
        result = streamed.stdoutText;
        stderr = streamed.stderrText;
        toolCounts = streamed.toolCounts;
        timedOut = streamed.timedOut;
      } else {
        const stdoutPromise = new Response(currentProc.stdout).text();
        const stderrPromise = new Response(currentProc.stderr).text();
        [result, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      }
      const exitCode = await currentProc.exited;
      currentProc = null;
      if (timedOut) {
        console.log(`
\u26A0\uFE0F  Process killed due to inactivity timeout (${opts.timeout} minutes)`);
      }
      const combinedOutput = `${result}
${stderr}`;
      const completionDetected = new RegExp(`<promise>\\s*${escapeRegex(opts.done)}\\s*</promise>`, "i").test(combinedOutput);
      const taskCompletionDetected = new RegExp(`<promise>\\s*${escapeRegex(opts.next)}\\s*</promise>`, "i").test(combinedOutput);
      const suggestedTasks = parseSuggestedTasks(combinedOutput);
      if (suggestedTasks.length > 0)
        appendSuggestedTasks(suggestedTasks, state.iteration);
      const iterationDuration = Date.now() - iterationStart;
      console.log(`
Iteration Summary`);
      console.log("\u2500".repeat(68));
      console.log(`Iteration: ${state.iteration}`);
      console.log(`Elapsed:   ${formatDuration(iterationDuration)}`);
      console.log(`Tools:     ${formatToolSummary(toolCounts) || "none"}`);
      console.log(`Exit code: ${exitCode}`);
      console.log(`Completion: ${completionDetected ? "detected" : "not detected"}`);
      const snapshotAfter = await captureFileSnapshot();
      const filesModified = getModifiedFilesSinceSnapshot(snapshotBefore, snapshotAfter);
      const errors = extractErrors(combinedOutput);
      history.iterations.push({
        iteration: state.iteration,
        startedAt: new Date(iterationStart).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: iterationDuration,
        toolsUsed: Object.fromEntries(toolCounts),
        filesModified,
        exitCode,
        completionDetected,
        errors
      });
      history.totalDurationMs += iterationDuration;
      const madeProgress = filesModified.length > 0 || taskCompletionDetected || completionDetected;
      if (!madeProgress)
        history.struggleIndicators.noProgressIterations++;
      else
        history.struggleIndicators.noProgressIterations = 0;
      if (iterationDuration < 30000)
        history.struggleIndicators.shortIterations++;
      else
        history.struggleIndicators.shortIterations = 0;
      if (errors.length === 0)
        history.struggleIndicators.repeatedErrors = {};
      else {
        for (const error of errors) {
          const key = error.substring(0, 100);
          history.struggleIndicators.repeatedErrors[key] = (history.struggleIndicators.repeatedErrors[key] || 0) + 1;
        }
      }
      saveHistory(history);
      if (completionDetected) {
        console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557`);
        console.log(`\u2551  \u2705 Completion detected!`);
        console.log(`\u2551  Completed in ${state.iteration} iteration(s)`);
        console.log(`\u2551  Total time: ${formatDurationLong(history.totalDurationMs)}`);
        console.log(`\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D`);
        if (milestoneFilter) {
          try {
            const tagName = `${milestoneFilter.toLowerCase()}-complete`;
            await $`git tag -a ${tagName} -m "Milestone ${milestoneFilter} completed"`.quiet();
            console.log(`\uD83C\uDFF7\uFE0F  Tagged: ${tagName}`);
          } catch {}
        }
        clearState();
        clearHistory();
        clearContext();
        break;
      }
      if (contextAtStart) {
        console.log(`\uD83D\uDCDD Context consumed`);
        clearContext();
      }
      if (!opts.noCommit) {
        try {
          const status = await $`git status --porcelain`.text();
          if (status.trim()) {
            await $`git add -A`;
            await $`git commit -m "Ralph iteration ${state.iteration}: work in progress"`.quiet();
            console.log(`\uD83D\uDCDD Auto-committed`);
          }
        } catch {}
      }
      state.iteration++;
      saveState(state);
      await new Promise((r) => setTimeout(r, 1000));
    } catch (error) {
      if (currentProc) {
        try {
          currentProc.kill();
        } catch {}
        currentProc = null;
      }
      console.error(`
\u274C Error in iteration ${state.iteration}:`, error);
      console.log("Continuing to next iteration...");
      history.iterations.push({
        iteration: state.iteration,
        startedAt: new Date(iterationStart).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - iterationStart,
        toolsUsed: {},
        filesModified: [],
        exitCode: -1,
        completionDetected: false,
        errors: [String(error).substring(0, 200)]
      });
      history.totalDurationMs += Date.now() - iterationStart;
      saveHistory(history);
      state.iteration++;
      saveState(state);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.version) {
    console.log(`ralph ${VERSION}`);
    process.exit(0);
  }
  if (parsed.flags.help) {
    switch (parsed.command) {
      case "run":
        console.log(HELP_RUN);
        break;
      case "status":
        console.log(HELP_STATUS);
        break;
      case "context":
        console.log(HELP_CONTEXT);
        break;
      case "tasks":
        console.log(HELP_TASKS);
        break;
      default:
        console.log(HELP_MAIN);
    }
    process.exit(0);
  }
  switch (parsed.command) {
    case "status":
      cmdStatus(parsed.flags);
      break;
    case "context":
      cmdContext(parsed.args, parsed.flags);
      break;
    case "tasks":
      cmdTasks(parsed.args, parsed.flags);
      break;
    case "run":
    default:
      await cmdRun(parsed.args, parsed.flags);
      break;
  }
}
main().catch((error) => {
  console.error("Fatal error:", error);
  clearState();
  process.exit(1);
});
