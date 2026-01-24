#!/usr/bin/env bun
/**
 * Ralph Wiggum Loop for AI agents
 *
 * Implementation of the Ralph Wiggum technique - continuous self-referential
 * AI loops for iterative development. Based on ghuntley.com/ralph/
 */

import { $ } from "bun";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";

const VERSION = "1.1.0";

// Workspace support - can be overridden via --workspace
let workspaceRoot = process.cwd();

// Context file path for mid-loop injection (computed after workspace is set)
function getStateDir() {
  return join(workspaceRoot, ".ralph");
}
function getStatePath() {
  return join(getStateDir(), "ralph-loop.state.json");
}
function getContextPath() {
  return join(getStateDir(), "ralph-context.md");
}
function getHistoryPath() {
  return join(getStateDir(), "ralph-history.json");
}
function getTasksPath() {
  return join(getStateDir(), "ralph-tasks.md");
}
function getSuggestedTasksPath() {
  return join(getStateDir(), "suggested-tasks.md");
}
function getLogDir() {
  return join(getStateDir(), "logs");
}

// Legacy aliases for backward compatibility
const stateDir = getStateDir();
const statePath = getStatePath();
const contextPath = getContextPath();
const historyPath = getHistoryPath();
const tasksPath = getTasksPath();

type AgentType = "opencode" | "claude-code" | "codex";

// Structured markdown task (with dependencies, verification, timing)
interface StructuredTask {
  id: string;
  title: string;
  milestone: string | null;
  status: "todo" | "in-progress" | "complete";
  depends: string[];
  verify: string | null;
  started: string | null;
  completed: string | null;
  originalLines: string[]; // For reconstruction
}

interface ParsedTasksFile {
  milestones: Map<string, StructuredTask[]>;
  allTasks: Map<string, StructuredTask>;
}

// Log file for session output
let logFilePath: string | null = null;

type AgentEnvOptions = { filterPlugins?: boolean; allowAllPermissions?: boolean };

type AgentBuildArgsOptions = { allowAllPermissions?: boolean };

interface AgentConfig {
  type: AgentType;
  command: string;
  buildArgs: (prompt: string, model: string, options?: AgentBuildArgsOptions) => string[];
  buildEnv: (options: AgentEnvOptions) => Record<string, string>;
  parseToolOutput: (line: string) => string | null;
  configName: string;
}

const AGENTS: Record<AgentType, AgentConfig> = {
  opencode: {
    type: "opencode",
    command: "opencode",
    buildArgs: (promptText, modelName, _options) => {
      const cmdArgs = ["run"];
      if (modelName) {
        cmdArgs.push("-m", modelName);
      }
      cmdArgs.push(promptText);
      return cmdArgs;
    },
    buildEnv: options => {
      const env = { ...process.env };
      if (options.filterPlugins || options.allowAllPermissions) {
        env.OPENCODE_CONFIG = ensureRalphConfig({
          filterPlugins: options.filterPlugins,
          allowAllPermissions: options.allowAllPermissions,
        });
      }
      return env;
    },
    parseToolOutput: line => {
      const match = stripAnsi(line).match(/^\|\s{2}([A-Za-z0-9_-]+)/);
      return match ? match[1] : null;
    },
    configName: "OpenCode",
  },
  "claude-code": {
    type: "claude-code",
    command: "claude",
    buildArgs: (promptText, modelName, options) => {
      const cmdArgs = ["-p", promptText];
      if (modelName) {
        cmdArgs.push("--model", modelName);
      }
      if (options?.allowAllPermissions) {
        cmdArgs.push("--dangerously-skip-permissions");
      }
      return cmdArgs;
    },
    buildEnv: () => ({ ...process.env }),
    parseToolOutput: line => {
      const match = stripAnsi(line).match(/(?:Using|Called|Tool:)\s+([A-Za-z0-9_-]+)/i);
      return match ? match[1] : null;
    },
    configName: "Claude Code",
  },
  codex: {
    type: "codex",
    command: "codex",
    buildArgs: (promptText, modelName, options) => {
      const cmdArgs = ["exec"];
      if (modelName) {
        cmdArgs.push("--model", modelName);
      }
      if (options?.allowAllPermissions) {
        cmdArgs.push("--full-auto");
      }
      cmdArgs.push(promptText);
      return cmdArgs;
    },
    buildEnv: () => ({ ...process.env }),
    parseToolOutput: line => {
      const match = stripAnsi(line).match(/(?:Tool:|Using|Calling|Running)\s+([A-Za-z0-9_-]+)/i);
      return match ? match[1] : null;
    },
    configName: "Codex",
  },
};
// Parse arguments
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Ralph Wiggum Loop - Iterative AI development with AI agents

Usage:
  ralph "<prompt>" [options]
  ralph --prompt-file <path> [options]

Arguments:
  prompt              Task description for the AI to work on

Options:
  --agent AGENT       AI agent to use: opencode (default), claude-code, codex

  --iterations N      Maximum iterations before stopping (default: unlimited)
  --completion-promise TEXT  Phrase that signals completion (default: COMPLETE)
  --tasks, -t         Enable Tasks Mode for structured task tracking (markdown)
  --task-promise TEXT Phrase that signals task completion (default: READY_FOR_NEXT_TASK)
  --model MODEL       Model to use (agent-specific, e.g., anthropic/claude-sonnet)
  --prompt-file, --file, -f  Read prompt content from a file
  --no-stream         Buffer agent output and print at the end
  --verbose-tools     Print every tool line (disable compact tool summary)
  --no-plugins        Disable non-auth OpenCode plugins for this run (opencode only)
  --no-commit         Don't auto-commit after each iteration
  --allow-all         Auto-approve all tool permissions (default: on)
  --no-allow-all      Require interactive permission prompts
  --version, -v       Show version
  --help, -h          Show this help

Workspace & Structured Tasks:
  --workspace, -w DIR   Run in a different directory (default: current dir)
  --repo PATH           Git repo to create worktree from (auto-creates worktree)
  --branch NAME         Branch name for new worktree (default: from prompt title)
  --tasks-file PATH     Use structured markdown tasks file with dependencies,
                        milestones, and verification commands (e.g., docs/tasks.md)
  --milestone, -m NAME  Only process tasks for this milestone (e.g., M2a)
  --log                 Enable logging all output to .ralph/logs/

Commands:
  --status            Show current Ralph loop status and history
  --status --tasks    Show status including current task list
  --add-context TEXT  Add context for the next iteration (or edit .ralph/ralph-context.md)
  --clear-context     Clear any pending context
  --list-tasks        Display the current task list with indices
  --add-task "desc"   Add a new task to the list
  --remove-task N     Remove task at index N (including subtasks)

Examples:
  ralph "Build a REST API for todos"
  ralph "Fix the auth bug" --iterations 10
  ralph "Add tests" --completion-promise "ALL TESTS PASS" --model openai/gpt-5.1
  ralph "Fix the bug" --agent codex --model gpt-5-codex
  ralph --prompt-file ./prompt.md --iterations 5
  ralph --status                                        # Check loop status
  ralph --add-context "Focus on the auth module first"  # Add hint for next iteration

  # Start new work (creates worktree from repo)
  ralph -f ~/plans/migration.md --repo ~/dev/my-project --tasks-file docs/tasks.md -m M1 -n 50
  
  # Continue existing work (from within worktree)
  cd ~/dev/my-project.worktrees/migration
  ralph -f .ralph/ralph-prompt.md --tasks-file docs/tasks.md -m M2a -n 30
  
  # Run in a different workspace (no worktree creation)
  ralph "Migrate the app" --workspace ~/projects/my-app --log

How it works:
  1. Sends your prompt to the selected AI agent
  2. AI agent works on the task
  3. Checks output for completion promise
  4. If not complete, repeats with same prompt
  5. AI sees its previous work in files
  6. Continues until promise detected or max iterations

To stop manually: Ctrl+C

Learn more: https://ghuntley.com/ralph/
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(`ralph ${VERSION}`);
  process.exit(0);
}

// History tracking interface
interface IterationHistory {
  iteration: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  toolsUsed: Record<string, number>;
  filesModified: string[];
  exitCode: number;
  completionDetected: boolean;
  errors: string[];
}

interface RalphHistory {
  iterations: IterationHistory[];
  totalDurationMs: number;
  struggleIndicators: {
    repeatedErrors: Record<string, number>;
    noProgressIterations: number;
    shortIterations: number;
  };
}

// Load history
function loadHistory(): RalphHistory {
  if (!existsSync(historyPath)) {
    return {
      iterations: [],
      totalDurationMs: 0,
      struggleIndicators: { repeatedErrors: {}, noProgressIterations: 0, shortIterations: 0 }
    };
  }
  try {
    return JSON.parse(readFileSync(historyPath, "utf-8"));
  } catch {
    return {
      iterations: [],
      totalDurationMs: 0,
      struggleIndicators: { repeatedErrors: {}, noProgressIterations: 0, shortIterations: 0 }
    };
  }
}

function saveHistory(history: RalphHistory): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

function clearHistory(): void {
  if (existsSync(historyPath)) {
    try {
      require("fs").unlinkSync(historyPath);
    } catch {}
  }
}

// Status command
if (args.includes("--status")) {
  const state = loadState();
  const history = loadHistory();
  const context = existsSync(contextPath) ? readFileSync(contextPath, "utf-8").trim() : null;
  // Show tasks if explicitly requested OR if active loop has tasks mode enabled
  const showTasks = args.includes("--tasks") || args.includes("-t") || state?.tasksMode;

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    Ralph Wiggum Status                           ║
╚══════════════════════════════════════════════════════════════════╝
`);

  if (state?.active) {
    const elapsed = Date.now() - new Date(state.startedAt).getTime();
    const elapsedStr = formatDurationLong(elapsed);
    console.log(`🔄 ACTIVE LOOP`);
    console.log(`   Iteration:    ${state.iteration}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : " (unlimited)"}`);
    console.log(`   Started:      ${state.startedAt}`);
    console.log(`   Elapsed:      ${elapsedStr}`);
    console.log(`   Promise:      ${state.completionPromise}`);
    const agentLabel = state.agent ? (AGENTS[state.agent]?.configName ?? state.agent) : "OpenCode";
    console.log(`   Agent:        ${agentLabel}`);
    if (state.model) console.log(`   Model:        ${state.model}`);
    if (state.tasksMode) {
      console.log(`   Tasks Mode:   ENABLED`);
      console.log(`   Task Promise: ${state.taskPromise}`);
    }
    console.log(`   Prompt:       ${state.prompt.substring(0, 60)}${state.prompt.length > 60 ? "..." : ""}`);
  } else {
    console.log(`⏹️  No active loop`);
  }

  if (context) {
    console.log(`\n📝 PENDING CONTEXT (will be injected next iteration):`);
    console.log(`   ${context.split("\n").join("\n   ")}`);
  }

  // Show tasks if requested
  if (showTasks) {
    if (existsSync(tasksPath)) {
      try {
        const tasksContent = readFileSync(tasksPath, "utf-8");
        const tasks = parseTasks(tasksContent);
        if (tasks.length > 0) {
          console.log(`\n📋 CURRENT TASKS:`);
          for (let i = 0; i < tasks.length; i++) {
            const task = tasks[i];
            const statusIcon = task.status === "complete" ? "✅" : task.status === "in-progress" ? "🔄" : "⏸️";
            console.log(`   ${i + 1}. ${statusIcon} ${task.text}`);

            for (const subtask of task.subtasks) {
              const subStatusIcon = subtask.status === "complete" ? "✅" : subtask.status === "in-progress" ? "🔄" : "⏸️";
              console.log(`      ${subStatusIcon} ${subtask.text}`);
            }
          }
          const complete = tasks.filter(t => t.status === "complete").length;
          const inProgress = tasks.filter(t => t.status === "in-progress").length;
          console.log(`\n   Progress: ${complete}/${tasks.length} complete, ${inProgress} in progress`);
        } else {
          console.log(`\n📋 CURRENT TASKS: (no tasks found)`);
        }
      } catch {
        console.log(`\n📋 CURRENT TASKS: (error reading tasks)`);
      }
    } else {
      console.log(`\n📋 CURRENT TASKS: (no tasks file found)`);
    }
  }

  if (history.iterations.length > 0) {
    console.log(`\n📊 HISTORY (${history.iterations.length} iterations)`);
    console.log(`   Total time:   ${formatDurationLong(history.totalDurationMs)}`);

    // Show last 5 iterations
    const recent = history.iterations.slice(-5);
    console.log(`\n   Recent iterations:`);
    for (const iter of recent) {
      const tools = Object.entries(iter.toolsUsed)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      const status = iter.completionDetected ? "✅" : iter.exitCode !== 0 ? "❌" : "🔄";
      console.log(`   ${status} #${iter.iteration}: ${formatDurationLong(iter.durationMs)} | ${tools || "no tools"}`);
    }

    // Struggle detection
    const struggle = history.struggleIndicators;
    const hasRepeatedErrors = Object.values(struggle.repeatedErrors).some(count => count >= 2);
    if (struggle.noProgressIterations >= 3 || struggle.shortIterations >= 3 || hasRepeatedErrors) {
      console.log(`\n⚠️  STRUGGLE INDICATORS:`);
      if (struggle.noProgressIterations >= 3) {
        console.log(`   - No file changes in ${struggle.noProgressIterations} iterations`);
      }
      if (struggle.shortIterations >= 3) {
        console.log(`   - ${struggle.shortIterations} very short iterations (< 30s)`);
      }
      const topErrors = Object.entries(struggle.repeatedErrors)
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      for (const [error, count] of topErrors) {
        console.log(`   - Same error ${count}x: "${error.substring(0, 50)}..."`);
      }
      console.log(`\n   💡 Consider using: ralph --add-context "your hint here"`);
    }
  }

  console.log("");
  process.exit(0);
}

// Add context command
const addContextIdx = args.indexOf("--add-context");
if (addContextIdx !== -1) {
  const contextText = args[addContextIdx + 1];
  if (!contextText) {
    console.error("Error: --add-context requires a text argument");
    console.error("Usage: ralph --add-context \"Your context or hint here\"");
    process.exit(1);
  }

  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  // Append to existing context or create new
  const timestamp = new Date().toISOString();
  const newEntry = `\n## Context added at ${timestamp}\n${contextText}\n`;

  if (existsSync(contextPath)) {
    const existing = readFileSync(contextPath, "utf-8");
    writeFileSync(contextPath, existing + newEntry);
  } else {
    writeFileSync(contextPath, `# Ralph Loop Context\n${newEntry}`);
  }

  console.log(`✅ Context added for next iteration`);
  console.log(`   File: ${contextPath}`);

  const state = loadState();
  if (state?.active) {
    console.log(`   Will be picked up in iteration ${state.iteration + 1}`);
  } else {
    console.log(`   Will be used when loop starts`);
  }
  process.exit(0);
}

// Clear context command
if (args.includes("--clear-context")) {
  if (existsSync(contextPath)) {
    require("fs").unlinkSync(contextPath);
    console.log(`✅ Context cleared`);
  } else {
    console.log(`ℹ️  No pending context to clear`);
  }
  process.exit(0);
}

// List tasks command
if (args.includes("--list-tasks")) {
  if (!existsSync(tasksPath)) {
    console.log("No tasks file found. Use --add-task to create your first task.");
    process.exit(0);
  }

  try {
    const tasksContent = readFileSync(tasksPath, "utf-8");
    const tasks = parseTasks(tasksContent);
    displayTasksWithIndices(tasks);
  } catch (error) {
    console.error("Error reading tasks file:", error);
    process.exit(1);
  }
  process.exit(0);
}

// Add task command
const addTaskIdx = args.indexOf("--add-task");
if (addTaskIdx !== -1) {
  const taskDescription = args[addTaskIdx + 1];
  if (!taskDescription) {
    console.error("Error: --add-task requires a description");
    console.error("Usage: ralph --add-task \"Task description\"");
    process.exit(1);
  }

  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  try {
    let tasksContent = "";
    if (existsSync(tasksPath)) {
      tasksContent = readFileSync(tasksPath, "utf-8");
    } else {
      tasksContent = "# Ralph Tasks\n\n";
    }

    const newTaskContent = tasksContent.trimEnd() + "\n" + `- [ ] ${taskDescription}\n`;
    writeFileSync(tasksPath, newTaskContent);
    console.log(`✅ Task added: "${taskDescription}"`);
  } catch (error) {
    console.error("Error adding task:", error);
    process.exit(1);
  }
  process.exit(0);
}

// Remove task command
const removeTaskIdx = args.indexOf("--remove-task");
if (removeTaskIdx !== -1) {
  const taskIndexStr = args[removeTaskIdx + 1];
  if (!taskIndexStr || isNaN(parseInt(taskIndexStr))) {
    console.error("Error: --remove-task requires a valid number");
    console.error("Usage: ralph --remove-task 3");
    process.exit(1);
  }

  const taskIndex = parseInt(taskIndexStr);

  if (!existsSync(tasksPath)) {
    console.error("Error: No tasks file found");
    process.exit(1);
  }

  try {
    const tasksContent = readFileSync(tasksPath, "utf-8");
    const tasks = parseTasks(tasksContent);

    if (taskIndex < 1 || taskIndex > tasks.length) {
      console.error(`Error: Task index ${taskIndex} is out of range (1-${tasks.length})`);
      process.exit(1);
    }

    // Remove the task and its subtasks
    const lines = tasksContent.split("\n");
    const newLines: string[] = [];
    let inRemovedTask = false;
    let currentTaskLine = 0;

    for (const line of lines) {
      // Check if this is a top-level task (starts with "- [" at beginning of line)
      if (line.match(/^- \[/)) {
        currentTaskLine++;
        if (currentTaskLine === taskIndex) {
          inRemovedTask = true;
          continue; // Skip this task line
        } else {
          inRemovedTask = false;
        }
      }

      // Skip all indented content under the removed task (subtasks, notes, etc.)
      if (inRemovedTask && line.match(/^\s+/) && line.trim() !== "") {
        continue;
      }

      newLines.push(line);
    }

    writeFileSync(tasksPath, newLines.join("\n"));
    console.log(`✅ Removed task ${taskIndex} and its subtasks`);
  } catch (error) {
    console.error("Error removing task:", error);
    process.exit(1);
  }
  process.exit(0);
}

function formatDurationLong(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

// Task tracking types and functions
interface Task {
  text: string;
  status: "todo" | "in-progress" | "complete";
  subtasks: Task[];
  originalLine: string;
}

// Parse markdown tasks into structured data
function parseTasks(content: string): Task[] {
  const tasks: Task[] = [];
  const lines = content.split("\n");
  let currentTask: Task | null = null;

  for (const line of lines) {
    // Top-level task: starts with "- [" at beginning (no leading whitespace)
    const topLevelMatch = line.match(/^- \[([ x\/])\]\s*(.+)/);
    if (topLevelMatch) {
      if (currentTask) {
        tasks.push(currentTask);
      }
      const [, statusChar, text] = topLevelMatch;
      let status: Task["status"] = "todo";
      if (statusChar === "x") status = "complete";
      else if (statusChar === "/") status = "in-progress";

      currentTask = { text, status, subtasks: [], originalLine: line };
      continue;
    }

    // Subtask: starts with whitespace followed by "- ["
    const subtaskMatch = line.match(/^\s+- \[([ x\/])\]\s*(.+)/);
    if (subtaskMatch && currentTask) {
      const [, statusChar, text] = subtaskMatch;
      let status: Task["status"] = "todo";
      if (statusChar === "x") status = "complete";
      else if (statusChar === "/") status = "in-progress";

      currentTask.subtasks.push({ text, status, subtasks: [], originalLine: line });
    }
  }

  if (currentTask) {
    tasks.push(currentTask);
  }

  return tasks;
}

// Display tasks with numbering for CLI
function displayTasksWithIndices(tasks: Task[]): void {
  if (tasks.length === 0) {
    console.log("No tasks found.");
    return;
  }

  console.log("Current tasks:");
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const statusIcon = task.status === "complete" ? "✅" : task.status === "in-progress" ? "🔄" : "⏸️";
    console.log(`${i + 1}. ${statusIcon} ${task.text}`);

    for (const subtask of task.subtasks) {
      const subStatusIcon = subtask.status === "complete" ? "✅" : subtask.status === "in-progress" ? "🔄" : "⏸️";
      console.log(`   ${subStatusIcon} ${subtask.text}`);
    }
  }
}

// Find the current in-progress task (marked with [/])
function findCurrentTask(tasks: Task[]): Task | null {
  for (const task of tasks) {
    if (task.status === "in-progress") {
      return task;
    }
  }
  return null;
}

// Find the next incomplete task
function findNextTask(tasks: Task[]): Task | null {
  for (const task of tasks) {
    if (task.status === "todo") {
      return task;
    }
  }
  return null;
}

// Check if all tasks are complete
function allTasksComplete(tasks: Task[]): boolean {
  return tasks.length > 0 && tasks.every(t => t.status === "complete");
}

// ============================================================================
// Structured Markdown Tasks - Task tracking with dependencies and verification
// ============================================================================

let structuredTasksFile: string | null = null;
let milestoneFilter: string | null = null;

/**
 * Parse structured markdown tasks file
 * 
 * Format:
 * ## M1: Milestone Name
 * 
 * - [x] task-001: Task title here
 *   - depends: task-000
 *   - verify: `command to run`
 *   - started: 2026-01-24T19:00:00Z
 *   - completed: 2026-01-24T19:05:00Z
 * 
 * - [ ] task-002: Another task
 *   - depends: task-001
 *   - verify: `npm test`
 */
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
    // Milestone header: ## M1: Name or ## M1
    const milestoneMatch = line.match(/^##\s+(\S+)(?::\s*(.*))?$/);
    if (milestoneMatch) {
      saveCurrentTask();
      currentMilestone = milestoneMatch[1];
      if (!milestones.has(currentMilestone)) {
        milestones.set(currentMilestone, []);
      }
      continue;
    }

    // Task line: - [ ] id: title or - [x] id: title or - [/] id: title
    const taskMatch = line.match(/^-\s+\[([ x\/])\]\s+([a-zA-Z0-9_-]+):\s*(.+)$/);
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

    // Metadata line (indented under task): - key: value
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

function loadStructuredTasks(): ParsedTasksFile | null {
  if (!structuredTasksFile) return null;
  const fullPath = join(workspaceRoot, structuredTasksFile);
  if (!existsSync(fullPath)) {
    return null;
  }
  try {
    const content = readFileSync(fullPath, "utf-8");
    return parseStructuredTasks(content);
  } catch {
    return null;
  }
}

function countStructuredTasks(milestone: string | null, status: StructuredTask["status"]): number {
  const data = loadStructuredTasks();
  if (!data) return 0;
  
  let tasks: StructuredTask[];
  if (milestone) {
    tasks = data.milestones.get(milestone) || [];
  } else {
    tasks = Array.from(data.allTasks.values());
  }
  
  return tasks.filter((t) => t.status === status).length;
}

function getNextStructuredTask(milestone: string | null): StructuredTask | null {
  const data = loadStructuredTasks();
  if (!data) return null;

  let tasks: StructuredTask[];
  if (milestone) {
    tasks = data.milestones.get(milestone) || [];
  } else {
    tasks = Array.from(data.allTasks.values());
  }

  for (const task of tasks) {
    if (task.status !== "todo" && task.status !== "in-progress") continue;

    // Check dependencies
    const allDepsComplete = task.depends.every((depId) => {
      const dep = data.allTasks.get(depId);
      return dep?.status === "complete";
    });
    
    if (allDepsComplete) {
      return task;
    }
  }
  return null;
}

function allStructuredTasksComplete(milestone: string | null): boolean {
  const data = loadStructuredTasks();
  if (!data) return false;
  
  let tasks: StructuredTask[];
  if (milestone) {
    tasks = data.milestones.get(milestone) || [];
  } else {
    tasks = Array.from(data.allTasks.values());
  }
  
  return tasks.length > 0 && tasks.every((t) => t.status === "complete");
}

function getStructuredTasksSummary(milestone: string | null): { pending: number; inProgress: number; completed: number; total: number } {
  const pending = countStructuredTasks(milestone, "todo");
  const inProgress = countStructuredTasks(milestone, "in-progress");
  const completed = countStructuredTasks(milestone, "complete");
  return { pending, inProgress, completed, total: pending + inProgress + completed };
}

// ============================================================================
// Suggested tasks
// ============================================================================

/**
 * Parse suggested tasks from agent output
 * Format: <suggest-task>task description</suggest-task>
 * Or: <suggest-task milestone="M2a">task description</suggest-task>
 */
function parseSuggestedTasks(output: string): Array<{ task: string; milestone: string | null }> {
  const suggestions: Array<{ task: string; milestone: string | null }> = [];
  const regex = /<suggest-task(?:\s+milestone="([^"]*)")?\s*>([\s\S]*?)<\/suggest-task>/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const milestone = match[1] || null;
    const task = match[2].trim();
    if (task) {
      suggestions.push({ task, milestone });
    }
  }
  return suggestions;
}

/**
 * Append suggested tasks to the suggested-tasks.md file
 */
function appendSuggestedTasks(suggestions: Array<{ task: string; milestone: string | null }>, iteration: number): void {
  if (suggestions.length === 0) return;
  
  const suggestedPath = getSuggestedTasksPath();
  const timestamp = new Date().toISOString();
  
  let content = "";
  if (existsSync(suggestedPath)) {
    content = readFileSync(suggestedPath, "utf-8");
  } else {
    content = "# Suggested Tasks\n\nTasks suggested by the Ralph loop agent for review.\n\n";
  }
  
  content += `\n## From Iteration ${iteration} (${timestamp})\n\n`;
  for (const { task, milestone } of suggestions) {
    if (milestone) {
      content += `- [ ] ${task}\n  - suggested-milestone: ${milestone}\n`;
    } else {
      content += `- [ ] ${task}\n`;
    }
  }
  
  writeFileSync(suggestedPath, content);
  console.log(`📝 ${suggestions.length} task suggestion(s) written to .ralph/suggested-tasks.md`);
}

// ============================================================================
// Worktree management
// ============================================================================

/**
 * Extract worktree name from prompt file's first # heading
 * "# Zappi-UI Migration" -> "zappi-ui-migration"
 */
function extractWorktreeName(promptContent: string): string {
  const match = promptContent.match(/^#\s+(.+)$/m);
  if (!match) {
    console.error("Error: No # heading found in prompt file.");
    console.error("Add a title like: # My Project Migration");
    process.exit(1);
  }
  
  // Sanitize: lowercase, replace non-alphanumeric with hyphens, trim hyphens
  return match[1]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Check if a git branch exists (local or remote)
 */
async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  try {
    // Check local branches
    const localResult = await $`git -C ${repoDir} branch --list ${branch}`.text();
    if (localResult.trim()) return true;
    
    // Check remote branches
    const remoteResult = await $`git -C ${repoDir} branch -r --list origin/${branch}`.text();
    return !!remoteResult.trim();
  } catch {
    return false;
  }
}

/**
 * Get the default branch (main or master)
 */
async function getDefaultBranch(repoDir: string): Promise<string> {
  try {
    // Try to get from remote HEAD
    const result = await $`git -C ${repoDir} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`.text();
    const match = result.match(/refs\/remotes\/origin\/(.+)/);
    if (match) return match[1].trim();
  } catch {
    // Ignore
  }
  
  // Fallback: check if main or master exists
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
  return "main"; // TypeScript needs this
}

/**
 * Prompt user for confirmation (y/N)
 */
async function confirm(message: string): Promise<boolean> {
  process.stdout.write(`${message} [y/N] `);
  
  // Read from stdin
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  
  const answer = new TextDecoder().decode(value).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/**
 * Merge tasks from source into target, preserving completed tasks and avoiding duplicates
 */
function mergeTaskFiles(targetPath: string, sourcePath: string): void {
  if (!existsSync(sourcePath)) return;
  if (!existsSync(targetPath)) {
    // Just copy if target doesn't exist
    const { copyFileSync } = require("fs");
    copyFileSync(sourcePath, targetPath);
    return;
  }
  
  const targetContent = readFileSync(targetPath, "utf-8");
  const sourceContent = readFileSync(sourcePath, "utf-8");
  
  const targetTasks = parseStructuredTasks(targetContent);
  const sourceTasks = parseStructuredTasks(sourceContent);
  
  // Find tasks in source that don't exist in target
  const newTasks: StructuredTask[] = [];
  for (const [id, task] of sourceTasks.allTasks) {
    if (!targetTasks.allTasks.has(id)) {
      newTasks.push(task);
    }
  }
  
  if (newTasks.length === 0) {
    console.log("   No new tasks to merge");
    return;
  }
  
  // Append new tasks to the target file
  let appendContent = "\n";
  let currentMilestone: string | null = null;
  
  for (const task of newTasks) {
    // Add milestone header if changed
    if (task.milestone !== currentMilestone) {
      currentMilestone = task.milestone;
      if (currentMilestone) {
        appendContent += `\n## ${currentMilestone}\n\n`;
      }
    }
    
    // Add task
    const statusChar = task.status === "complete" ? "x" : task.status === "in-progress" ? "/" : " ";
    appendContent += `- [${statusChar}] ${task.id}: ${task.title}\n`;
    
    if (task.depends.length > 0) {
      appendContent += `  - depends: ${task.depends.join(", ")}\n`;
    }
    if (task.verify) {
      appendContent += `  - verify: \`${task.verify}\`\n`;
    }
    if (task.started) {
      appendContent += `  - started: ${task.started}\n`;
    }
    if (task.completed) {
      appendContent += `  - completed: ${task.completed}\n`;
    }
    appendContent += "\n";
  }
  
  const { appendFileSync } = require("fs");
  appendFileSync(targetPath, appendContent);
  console.log(`   Merged ${newTasks.length} new tasks`);
}

/**
 * Create or reuse a git worktree
 */
async function setupWorktree(
  repo: string,
  promptContent: string,
  branch: string | null,
  promptFilePath: string,
  tasksFilePath: string | null
): Promise<{ worktreePath: string; promptFile: string; tasksFile: string | null }> {
  // Validate repo is a git repository
  if (!existsSync(join(repo, ".git"))) {
    console.error(`Error: Not a git repository: ${repo}`);
    process.exit(1);
  }
  
  // Extract worktree name from prompt
  const worktreeName = extractWorktreeName(promptContent);
  const worktreePath = `${repo}.worktrees/${worktreeName}`;
  const effectiveBranch = branch || worktreeName;
  
  console.log(`\n📁 Worktree Setup`);
  console.log(`   Name: ${worktreeName}`);
  console.log(`   Path: ${worktreePath}`);
  console.log(`   Branch: ${effectiveBranch}`);
  
  // Check if worktree already exists
  if (existsSync(worktreePath)) {
    console.log(`   Status: Using existing worktree`);
    
    // Check if tasks need merging
    if (tasksFilePath && existsSync(tasksFilePath)) {
      const targetTasksPath = join(worktreePath, tasksFilePath);
      if (existsSync(targetTasksPath)) {
        console.log(`   Merging tasks...`);
        mergeTaskFiles(targetTasksPath, tasksFilePath);
      }
    }
    
    return {
      worktreePath,
      promptFile: join(worktreePath, ".ralph", "ralph-prompt.md"),
      tasksFile: tasksFilePath ? tasksFilePath : null,
    };
  }
  
  // Fetch latest from remote
  console.log(`   Fetching from origin...`);
  try {
    await $`git -C ${repo} fetch origin`.quiet();
  } catch (e) {
    console.error(`   Warning: Could not fetch from origin`);
  }
  
  // Check if branch already exists
  const branchAlreadyExists = await branchExists(repo, effectiveBranch);
  
  if (branchAlreadyExists) {
    console.log(`   Branch '${effectiveBranch}' already exists.`);
    const confirmed = await confirm(`   Reuse existing branch?`);
    if (!confirmed) {
      console.error("   Aborted. Specify a different branch with --branch");
      process.exit(1);
    }
    
    // Create worktree from existing branch
    console.log(`   Creating worktree from existing branch...`);
    await $`git -C ${repo} worktree add ${worktreePath} ${effectiveBranch}`;
  } else {
    // Get default branch
    const defaultBranch = await getDefaultBranch(repo);
    console.log(`   Creating new branch from origin/${defaultBranch}...`);
    
    // Create worktree directory parent if needed
    const worktreeParent = join(repo + ".worktrees");
    if (!existsSync(worktreeParent)) {
      mkdirSync(worktreeParent, { recursive: true });
    }
    
    // Create worktree with new branch
    await $`git -C ${repo} worktree add -b ${effectiveBranch} ${worktreePath} origin/${defaultBranch}`;
  }
  
  // Create .ralph directory in worktree
  const ralphDir = join(worktreePath, ".ralph");
  if (!existsSync(ralphDir)) {
    mkdirSync(ralphDir, { recursive: true });
  }
  
  // Copy prompt file
  const targetPromptPath = join(ralphDir, "ralph-prompt.md");
  const { copyFileSync } = require("fs");
  copyFileSync(promptFilePath, targetPromptPath);
  console.log(`   Copied prompt to .ralph/ralph-prompt.md`);
  
  // Copy or merge tasks file
  let finalTasksFile: string | null = null;
  if (tasksFilePath && existsSync(tasksFilePath)) {
    const targetTasksPath = join(worktreePath, tasksFilePath);
    const targetTasksDir = join(worktreePath, tasksFilePath.split("/").slice(0, -1).join("/"));
    
    if (targetTasksDir && !existsSync(targetTasksDir)) {
      mkdirSync(targetTasksDir, { recursive: true });
    }
    
    if (existsSync(targetTasksPath)) {
      console.log(`   Merging tasks...`);
      mergeTaskFiles(targetTasksPath, tasksFilePath);
    } else {
      copyFileSync(tasksFilePath, targetTasksPath);
      console.log(`   Copied tasks to ${tasksFilePath}`);
    }
    finalTasksFile = tasksFilePath;
  }
  
  console.log(`   ✅ Worktree ready`);
  
  return {
    worktreePath,
    promptFile: ".ralph/ralph-prompt.md",
    tasksFile: finalTasksFile,
  };
}

// ============================================================================
// Logging to file
// ============================================================================

function initLogFile(): void {
  if (!logFilePath) return;
  
  const logDir = getLogDir();
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const milestone = milestoneFilter || "all";
  const fullLogPath = join(logDir, `${milestone}-${timestamp}.log`);
  
  // Store for later use
  logFilePath = fullLogPath;
  
  // Write header
  const header = `==========================================
Ralph Wiggum Session Log
==========================================
Started:      ${new Date().toLocaleString()}
Milestone:    ${milestoneFilter || "ALL"}
Working Dir:  ${workspaceRoot}
Tasks File:   ${structuredTasksFile || "N/A"}
==========================================

`;
  writeFileSync(fullLogPath, header);
}

function logToFile(message: string): void {
  if (!logFilePath || !existsSync(logFilePath)) return;
  try {
    const { appendFileSync } = require("fs");
    appendFileSync(logFilePath, message);
  } catch {
    // Ignore logging errors
  }
}

function logBoth(message: string): void {
  console.log(message);
  logToFile(stripAnsi(message) + "\n");
}

// Parse options
let prompt = "";

let maxIterations = 0; // 0 = unlimited
let completionPromise = "COMPLETE";
let tasksMode = false;
let taskPromise = "READY_FOR_NEXT_TASK";
let model = "anthropic/claude-sonnet-4-5";
let agentType: AgentType = "opencode";
let autoCommit = true;
let disablePlugins = false;
let allowAllPermissions = true;
let promptFile = "";
let streamOutput = true;
let verboseTools = false;
let promptSource = "";

// Repo and worktree options
let repoPath: string | null = null;
let branchName: string | null = null;

const promptParts: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === "--agent") {
    const val = args[++i];
    if (!val || !["opencode", "claude-code", "codex"].includes(val)) {
      console.error("Error: --agent requires: 'opencode', 'claude-code', or 'codex'");
      process.exit(1);
    }
    agentType = val as AgentType;

  } else if (arg === "--iterations" || arg === "--max-iterations" || arg === "-n") {
    const val = args[++i];
    if (!val || isNaN(parseInt(val))) {
      console.error("Error: --iterations requires a number");
      process.exit(1);
    }
    maxIterations = parseInt(val);
  } else if (arg === "--completion-promise") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --completion-promise requires a value");
      process.exit(1);
    }
    completionPromise = val;
  } else if (arg === "--tasks" || arg === "-t") {
    tasksMode = true;
  } else if (arg === "--task-promise") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --task-promise requires a value");
      process.exit(1);
    }
    taskPromise = val;
  } else if (arg === "--model") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --model requires a value");
      process.exit(1);
    }
    model = val;
  } else if (arg === "--prompt-file" || arg === "--file" || arg === "-f") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --prompt-file requires a file path");
      process.exit(1);
    }
    promptFile = val;
  } else if (arg === "--workspace" || arg === "-w") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --workspace requires a directory path");
      process.exit(1);
    }
    if (!existsSync(val)) {
      console.error(`Error: Workspace directory does not exist: ${val}`);
      process.exit(1);
    }
    workspaceRoot = val;
  } else if (arg === "--tasks-file") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --tasks-file requires a file path");
      process.exit(1);
    }
    structuredTasksFile = val;
  } else if (arg === "--milestone" || arg === "-m") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --milestone requires a value");
      process.exit(1);
    }
    milestoneFilter = val;
  } else if (arg === "--log" || arg === "--log-file") {
    // Enable logging - will auto-generate filename
    logFilePath = "auto";
  } else if (arg === "--repo") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --repo requires a directory path");
      process.exit(1);
    }
    repoPath = val;
  } else if (arg === "--branch") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --branch requires a branch name");
      process.exit(1);
    }
    branchName = val;
  } else if (arg === "--no-stream") {
    streamOutput = false;
  } else if (arg === "--stream") {
    streamOutput = true;
  } else if (arg === "--verbose-tools") {
    verboseTools = true;
  } else if (arg === "--no-commit") {
    autoCommit = false;
  } else if (arg === "--no-plugins") {
    disablePlugins = true;
  } else if (arg === "--allow-all") {
    allowAllPermissions = true;
  } else if (arg === "--no-allow-all") {
    allowAllPermissions = false;
  } else if (arg.startsWith("-")) {
    console.error(`Error: Unknown option: ${arg}`);
    console.error("Run 'ralph --help' for available options");
    process.exit(1);
  } else {
    promptParts.push(arg);
  }
}

function readPromptFile(path: string): string {
  if (!existsSync(path)) {
    console.error(`Error: Prompt file not found: ${path}`);
    process.exit(1);
  }
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      console.error(`Error: Prompt path is not a file: ${path}`);
      process.exit(1);
    }
  } catch {
    console.error(`Error: Unable to stat prompt file: ${path}`);
    process.exit(1);
  }
  try {
    const content = readFileSync(path, "utf-8");
    if (!content.trim()) {
      console.error(`Error: Prompt file is empty: ${path}`);
      process.exit(1);
    }
    return content;
  } catch {
    console.error(`Error: Unable to read prompt file: ${path}`);
    process.exit(1);
  }
}

if (promptFile) {
  promptSource = promptFile;
  prompt = readPromptFile(promptFile);
} else if (promptParts.length === 1 && existsSync(promptParts[0])) {
  promptSource = promptParts[0];
  prompt = readPromptFile(promptParts[0]);
} else {
  prompt = promptParts.join(" ");
}

if (!prompt) {
  console.error("Error: No prompt provided");
  console.error("Usage: ralph \"Your task description\" [options]");
  console.error("Run 'ralph --help' for more information");
  process.exit(1);
}

// Handle --repo flag: setup worktree if needed
// This is done as an async IIFE since we need to await git commands
const worktreeSetupPromise = (async () => {
  if (repoPath) {
    if (!promptFile && !promptSource) {
      console.error("Error: --repo requires --prompt-file (-f) to extract worktree name from");
      process.exit(1);
    }
    
    const result = await setupWorktree(
      repoPath,
      prompt,
      branchName,
      promptSource || promptFile,
      structuredTasksFile
    );
    
    // Update paths to point to worktree
    workspaceRoot = result.worktreePath;
    promptFile = result.promptFile;
    promptSource = result.promptFile;
    if (result.tasksFile) {
      structuredTasksFile = result.tasksFile;
    }
    
    // Re-read prompt from new location (it's now in the worktree)
    const newPromptPath = join(workspaceRoot, promptFile);
    if (existsSync(newPromptPath)) {
      prompt = readFileSync(newPromptPath, "utf-8");
    }
  }
})();


interface RalphState {
  active: boolean;
  iteration: number;

  maxIterations: number;
  completionPromise: string;
  tasksMode: boolean;
  taskPromise: string;
  prompt: string;
  startedAt: string;
  model: string;
  agent: AgentType;
  // New fields for workspace and structured tasks
  workspaceRoot?: string;
  structuredTasksFile?: string | null;
  milestoneFilter?: string | null;
  logFile?: string | null;
}

// Create or update state
function saveState(state: RalphState): void {
  const dir = getStateDir();
  const path = getStatePath();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function loadState(): RalphState | null {
  const path = getStatePath();
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function clearState(): void {
  if (existsSync(statePath)) {
    try {
      require("fs").unlinkSync(statePath);
    } catch {}
  }
}

function loadPluginsFromConfig(configPath: string): string[] {
  if (!existsSync(configPath)) {
    return [];
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    // Basic JSONC support: strip // and /* */ comments.
    const withoutBlock = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const withoutLine = withoutBlock.replace(/^\s*\/\/.*$/gm, "");
    const parsed = JSON.parse(withoutLine);
    const plugins = parsed?.plugin;
    return Array.isArray(plugins) ? plugins.filter(p => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function ensureRalphConfig(options: { filterPlugins?: boolean; allowAllPermissions?: boolean }): string {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  const configPath = join(stateDir, "ralph-opencode.config.json");
  const userConfigPath = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"), "opencode", "opencode.json");
  const projectConfigPath = join(process.cwd(), ".ralph", "opencode.json");
  const legacyProjectConfigPath = join(process.cwd(), ".opencode", "opencode.json");

  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
  };

  // Filter plugins if requested (only keep auth plugins)
  if (options.filterPlugins) {
    const plugins = [
      ...loadPluginsFromConfig(userConfigPath),
      ...loadPluginsFromConfig(projectConfigPath),
      ...loadPluginsFromConfig(legacyProjectConfigPath),
    ];
    config.plugin = Array.from(new Set(plugins)).filter(p => /auth/i.test(p));
  }

  // Auto-allow all permissions for non-interactive use
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
      external_directory: "allow",
    };
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

async function validateAgent(agent: AgentConfig): Promise<void> {
  // Use Bun.which() for cross-platform executable detection (works on Windows, macOS, Linux)
  const path = Bun.which(agent.command);
  if (!path) {
    console.error(`Error: ${agent.configName} CLI ('${agent.command}') not found.`);
    process.exit(1);
  }
}

// Build the full prompt with iteration context
function loadContext(): string | null {
  if (!existsSync(contextPath)) {
    return null;
  }
  try {
    const content = readFileSync(contextPath, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

function clearContext(): void {
  if (existsSync(contextPath)) {
    try {
      require("fs").unlinkSync(contextPath);
    } catch {}
  }
}

/**
 * Build the prompt for the current iteration.
 * @param state - Current loop state
 * @param _agent - Agent config (reserved for future agent-specific prompt customization)
 */
function buildPrompt(state: RalphState, _agent: AgentConfig): string {
  const context = loadContext();
  const contextSection = context
    ? `
## Additional Context (added by user mid-loop)

${context}

---
`
    : "";

  // Structured Tasks mode: task tracking with dependencies and verification
  if (state.structuredTasksFile) {
    const tasksSection = getStructuredTasksModeSection(state);
    return `
# Ralph Wiggum Loop - Iteration ${state.iteration}

You are in an iterative development loop working through a structured task list.
${contextSection}${tasksSection}
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

## Suggesting New Tasks

If you discover work that should be done but isn't in the task list, suggest it:

\`\`\`
<suggest-task>Description of the task that should be added</suggest-task>
<suggest-task milestone="M2b">Task for a specific milestone</suggest-task>
\`\`\`

Suggestions are saved to .ralph/suggested-tasks.md for human review.
Do NOT add tasks directly to the main task file - only suggest them.

## Current Iteration: ${state.iteration}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : " (unlimited)"}

Structured Tasks Mode: ENABLED${state.milestoneFilter ? ` (Milestone: ${state.milestoneFilter})` : ""}

Now, work on the current task. Good luck!
`.trim();
  }

  // Markdown Tasks mode: use task-specific instructions
  if (state.tasksMode) {
    const tasksSection = getTasksModeSection(state);
    return `
# Ralph Wiggum Loop - Iteration ${state.iteration}

You are in an iterative development loop working through a task list.
${contextSection}${tasksSection}
## Your Main Goal

${state.prompt}

## Critical Rules

- Work on ONE task at a time from .ralph/ralph-tasks.md
- ONLY output <promise>${state.taskPromise}</promise> when the current task is complete and marked in ralph-tasks.md
- ONLY output <promise>${state.completionPromise}</promise> when ALL tasks are truly done
- Do NOT lie or output false promises to exit the loop
- If stuck, try a different approach
- Check your work before claiming completion

## Current Iteration: ${state.iteration}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : " (unlimited)"}

Tasks Mode: ENABLED - Work on one task at a time from ralph-tasks.md

Now, work on the current task. Good luck!
`.trim();
  }

  // Default mode: simple instructions without tool-specific mentions
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

// Generate the tasks mode section for the prompt
function getTasksModeSection(state: RalphState): string {
  if (!existsSync(tasksPath)) {
    return `
## TASKS MODE: Enabled (no tasks file found)

Create .ralph/ralph-tasks.md with your task list, or use \`ralph --add-task "description"\` to add tasks.
`;
  }

  try {
    const tasksContent = readFileSync(tasksPath, "utf-8");
    const tasks = parseTasks(tasksContent);
    const currentTask = findCurrentTask(tasks);
    const nextTask = findNextTask(tasks);

    let taskInstructions = "";
    if (currentTask) {
      taskInstructions = `
🔄 CURRENT TASK: "${currentTask.text}"
   Focus on completing this specific task.
   When done: Mark as [x] in .ralph/ralph-tasks.md and output <promise>${state.taskPromise}</promise>`;
    } else if (nextTask) {
      taskInstructions = `
📍 NEXT TASK: "${nextTask.text}"
   Mark as [/] in .ralph/ralph-tasks.md before starting.
   When done: Mark as [x] and output <promise>${state.taskPromise}</promise>`;
    } else if (allTasksComplete(tasks)) {
      taskInstructions = `
✅ ALL TASKS COMPLETE!
   Output <promise>${state.completionPromise}</promise> to finish.`;
    } else {
      taskInstructions = `
📋 No tasks found. Add tasks to .ralph/ralph-tasks.md or use \`ralph --add-task\``;
    }

    return `
## TASKS MODE: Working through task list

Current tasks from .ralph/ralph-tasks.md:
\`\`\`markdown
${tasksContent.trim()}
\`\`\`
${taskInstructions}

### Task Workflow
1. Find any task marked [/] (in progress). If none, pick the first [ ] task.
2. Mark the task as [/] in ralph-tasks.md before starting.
3. Complete the task.
4. Mark as [x] when verified complete.
5. Output <promise>${state.taskPromise}</promise> to move to the next task.
6. Only output <promise>${state.completionPromise}</promise> when ALL tasks are [x].

---
`;
  } catch {
    return `
## TASKS MODE: Error reading tasks file

Unable to read .ralph/ralph-tasks.md
`;
  }
}

// Generate the structured tasks mode section for the prompt
function getStructuredTasksModeSection(state: RalphState): string {
  const data = loadStructuredTasks();
  if (!data) {
    return `
## STRUCTURED TASKS MODE: No tasks file found

Tasks file not found: ${state.structuredTasksFile}

Create a structured markdown tasks file with this format:

\`\`\`markdown
# Tasks

## M1: Setup

- [ ] task-001: Create project directory
  - verify: \`ls -la project/\`

- [ ] task-002: Initialize npm
  - depends: task-001
  - verify: \`cat project/package.json\`

## M2: Implementation

- [ ] task-003: Add main module
  - depends: task-002
  - verify: \`node project/index.js\`
\`\`\`
`;
  }

  const milestone = state.milestoneFilter;
  const summary = getStructuredTasksSummary(milestone);
  const nextTask = getNextStructuredTask(milestone);
  const allComplete = allStructuredTasksComplete(milestone);

  // Build task list for display
  let tasks: StructuredTask[];
  if (milestone) {
    tasks = data.milestones.get(milestone) || [];
  } else {
    tasks = Array.from(data.allTasks.values());
  }
  
  const taskList = tasks.map((t) => {
    const statusIcon = t.status === "complete" ? "✅" : t.status === "in-progress" ? "🔄" : "⏸️";
    const deps = t.depends.length ? ` (depends: ${t.depends.join(", ")})` : "";
    return `${statusIcon} ${t.id}: ${t.title}${deps}`;
  }).join("\n");

  let taskInstructions = "";
  if (allComplete) {
    taskInstructions = `
✅ ALL TASKS COMPLETE!
   Output <promise>${state.completionPromise}</promise> to finish.`;
  } else if (nextTask) {
    taskInstructions = `
📍 NEXT TASK: ${nextTask.id}
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
⏳ No available tasks. Check dependencies - some tasks may be blocked.`;
  }

  return `
## STRUCTURED TASKS MODE: ${milestone ? `Milestone ${milestone}` : "All Tasks"}

**Summary:** ${summary.completed}/${summary.total} complete, ${summary.inProgress} in progress, ${summary.pending} pending

**Tasks:**
${taskList}
${taskInstructions}

### Task Workflow
1. Read ${state.structuredTasksFile} to find the next available task
2. Task must be marked [ ] and all dependencies must be [x]
3. Mark task as in-progress: change [ ] to [/], add "- started: <ISO timestamp>"
4. Do the work described in the task title
5. Run the verification command in the "verify" field
6. Mark task as complete: change [/] to [x], add "- completed: <ISO timestamp>"
7. Commit: git add . && git commit -m "chore: complete TASK_ID - title"
8. Output <promise>${state.taskPromise}</promise> to signal task completion
9. When ALL tasks are complete, output <promise>${state.completionPromise}</promise>

---
`;
}

// Check if output contains the completion promise
function checkCompletion(output: string, promise: string): boolean {
  const promisePattern = new RegExp(`<promise>\\s*${escapeRegex(promise)}\\s*</promise>`, "i");
  return promisePattern.test(output);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectPlaceholderPluginError(output: string): boolean {
  return output.includes("ralph-wiggum is not yet ready for use. This is a placeholder package.");
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-9;]*m/g, "");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatToolSummary(toolCounts: Map<string, number>, maxItems = 6): string {
  if (!toolCounts.size) return "";
  const entries = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, maxItems);
  const remaining = entries.length - shown.length;
  const parts = shown.map(([name, count]) => `${name} ${count}`);
  if (remaining > 0) {
    parts.push(`+${remaining} more`);
  }
  return parts.join(" • ");
}

function collectToolSummaryFromText(text: string, agent: AgentConfig): Map<string, number> {
  const counts = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const tool = agent.parseToolOutput(line);
    if (tool) {
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }
  }
  return counts;
}

function printIterationSummary(params: {
  iteration: number;
  elapsedMs: number;
  toolCounts: Map<string, number>;
  exitCode: number;
  completionDetected: boolean;
}): void {
  const toolSummary = formatToolSummary(params.toolCounts);
  console.log("\nIteration Summary");
  console.log("────────────────────────────────────────────────────────────────────");
  console.log(`Iteration: ${params.iteration}`);
  console.log(`Elapsed:   ${formatDuration(params.elapsedMs)}`);
  if (toolSummary) {
    console.log(`Tools:     ${toolSummary}`);
  } else {
    console.log("Tools:     none");
  }
  console.log(`Exit code: ${params.exitCode}`);
  console.log(`Completion promise: ${params.completionDetected ? "detected" : "not detected"}`);
}

async function streamProcessOutput(
  proc: ReturnType<typeof Bun.spawn>,
  options: {
    compactTools: boolean;
    toolSummaryIntervalMs: number;
    heartbeatIntervalMs: number;
    iterationStart: number;
    agent: AgentConfig;
  },
): Promise<{ stdoutText: string; stderrText: string; toolCounts: Map<string, number> }> {
  const toolCounts = new Map<string, number>();
  let stdoutText = "";
  let stderrText = "";
  let lastPrintedAt = Date.now();
  let lastActivityAt = Date.now();
  let lastToolSummaryAt = 0;

  const compactTools = options.compactTools;
  const parseToolOutput = options.agent.parseToolOutput;

  const maybePrintToolSummary = (force = false) => {
    if (!compactTools || toolCounts.size === 0) return;
    const now = Date.now();
    if (!force && now - lastToolSummaryAt < options.toolSummaryIntervalMs) {
      return;
    }
    const summary = formatToolSummary(toolCounts);
    if (summary) {
      console.log(`| Tools    ${summary}`);
      lastPrintedAt = Date.now();
      lastToolSummaryAt = Date.now();
    }
  };

  const handleLine = (line: string, isError: boolean) => {
    lastActivityAt = Date.now();
    const tool = parseToolOutput(line);
    if (tool) {
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      if (compactTools) {
        maybePrintToolSummary();
        return;
      }
    }
    if (line.length === 0) {
      console.log("");
      lastPrintedAt = Date.now();
      return;
    }
    if (isError) {
      console.error(line);
    } else {
      console.log(line);
    }
    lastPrintedAt = Date.now();
  };

  const streamText = async (
    stream: ReadableStream<Uint8Array> | null,
    onText: (chunk: string) => void,
    isError: boolean,
  ) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) {
        onText(text);
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line, isError);
        }
      }
    }
    const flushed = decoder.decode();
    if (flushed.length > 0) {
      onText(flushed);
      buffer += flushed;
    }
    if (buffer.length > 0) {
      handleLine(buffer, isError);
    }
  };

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastPrintedAt >= options.heartbeatIntervalMs) {
      const elapsed = formatDuration(now - options.iterationStart);
      const sinceActivity = formatDuration(now - lastActivityAt);
      console.log(`⏳ working... elapsed ${elapsed} · last activity ${sinceActivity} ago`);
      lastPrintedAt = now;
    }
  }, options.heartbeatIntervalMs);

  try {
    await Promise.all([
      streamText(
        proc.stdout,
        chunk => {
          stdoutText += chunk;
        },
        false,
      ),
      streamText(
        proc.stderr,
        chunk => {
          stderrText += chunk;
        },
        true,
      ),
    ]);
  } finally {
    clearInterval(heartbeatTimer);
  }

  if (compactTools) {
    maybePrintToolSummary(true);
  }

  return { stdoutText, stderrText, toolCounts };
}
// Main loop
// Helper to detect per-iteration file changes using content hashes
// Works correctly with --no-commit by comparing file content hashes

interface FileSnapshot {
  files: Map<string, string>; // filename -> hash/mtime
}

async function captureFileSnapshot(): Promise<FileSnapshot> {
  const files = new Map<string, string>();
  try {
    // Only track modified/staged/untracked files (not all tracked files)
    const status = await $`git status --porcelain`.text();

    const modifiedFiles: string[] = [];
    for (const line of status.split("\n")) {
      if (line.trim()) {
        modifiedFiles.push(line.substring(3).trim());
      }
    }

    // Get hash for each modified file
    for (const file of modifiedFiles) {
      try {
        const hash = await $`git hash-object ${file} 2>/dev/null`.text();
        files.set(file, hash.trim());
      } catch {
        // File may not exist, skip
      }
    }
  } catch {
    // Git not available or error
  }
  return { files };
}

function getModifiedFilesSinceSnapshot(before: FileSnapshot, after: FileSnapshot): string[] {
  const changedFiles: string[] = [];

  // Check for new or modified files
  for (const [file, hash] of after.files) {
    const prevHash = before.files.get(file);
    if (prevHash !== hash) {
      changedFiles.push(file);
    }
  }

  // Check for deleted files
  for (const [file] of before.files) {
    if (!after.files.has(file)) {
      changedFiles.push(file);
    }
  }

  return changedFiles;
}

// Helper to extract error patterns from output
function extractErrors(output: string): string[] {
  const errors: string[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const lower = line.toLowerCase();
    // Match common error patterns
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
      if (cleaned && !errors.includes(cleaned)) {
        errors.push(cleaned);
      }
    }
  }

  return errors.slice(0, 10); // Cap at 10 errors per iteration
}

async function runRalphLoop(): Promise<void> {
  // Check if a loop is already running
  const existingState = loadState();
  if (existingState?.active) {
    console.error(`Error: A Ralph loop is already active (iteration ${existingState.iteration})`);
    console.error(`Started at: ${existingState.startedAt}`);
    console.error(`To cancel it, press Ctrl+C in its terminal or delete ${statePath}`);
    process.exit(1);
  }

  const agentConfig = AGENTS[agentType];
  await validateAgent(agentConfig);
  if (disablePlugins && agentConfig.type === "claude-code") {
    console.warn("Warning: --no-plugins has no effect with Claude Code agent");
  }
  if (disablePlugins && agentConfig.type === "codex") {
    console.warn("Warning: --no-plugins has no effect with Codex agent");
  }

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    Ralph Wiggum Loop                            ║
║         Iterative AI Development with ${agentConfig.configName.padEnd(20, " ")}        ║
╚══════════════════════════════════════════════════════════════════╝
`);

  // Initialize log file if enabled
  if (logFilePath === "auto") {
    initLogFile();
  }

  // Initialize state
  const state: RalphState = {
    active: true,
    iteration: 1,

    maxIterations,
    completionPromise,
    tasksMode,
    taskPromise,
    prompt,
    startedAt: new Date().toISOString(),
    model,
    agent: agentType,
    workspaceRoot,
    structuredTasksFile,
    milestoneFilter,
    logFile: logFilePath,
  };

  saveState(state);

  // Create markdown tasks file if tasks mode is enabled and file doesn't exist
  const mdTasksPath = getTasksPath();
  const stateDirectory = getStateDir();
  if (tasksMode && !existsSync(mdTasksPath)) {
    if (!existsSync(stateDirectory)) {
      mkdirSync(stateDirectory, { recursive: true });
    }
    writeFileSync(mdTasksPath, "# Ralph Tasks\n\nAdd your tasks here:\n- [ ] Example task\n");
    console.log(`📋 Created tasks file: ${mdTasksPath}`);
  }

  // Initialize history tracking
  const history: RalphHistory = {
    iterations: [],
    totalDurationMs: 0,
    struggleIndicators: { repeatedErrors: {}, noProgressIterations: 0, shortIterations: 0 }
  };
  saveHistory(history);

  const promptPreview = prompt.replace(/\s+/g, " ").substring(0, 80) + (prompt.length > 80 ? "..." : "");
  if (promptSource) {
    console.log(`Task: ${promptSource}`);
    console.log(`Preview: ${promptPreview}`);
  } else {
    console.log(`Task: ${promptPreview}`);
  }
  console.log(`Completion promise: ${completionPromise}`);
  if (tasksMode) {
    console.log(`Tasks mode: ENABLED (markdown)`);
    console.log(`Task promise: ${taskPromise}`);
  }
  if (structuredTasksFile) {
    console.log(`Structured tasks: ${structuredTasksFile}`);
    if (milestoneFilter) {
      console.log(`Milestone filter: ${milestoneFilter}`);
    }
    const summary = getStructuredTasksSummary(milestoneFilter);
    console.log(`Task summary: ${summary.completed}/${summary.total} complete, ${summary.inProgress} in progress, ${summary.pending} pending`);
    const nextTask = getNextStructuredTask(milestoneFilter);
    if (nextTask) {
      console.log(`Next task: ${nextTask.id} - ${nextTask.title}`);
    }
  }

  console.log(`Iterations: ${maxIterations > 0 ? maxIterations : "unlimited"}`);
  console.log(`Agent: ${agentConfig.configName}`);
  if (model) console.log(`Model: ${model}`);
  if (disablePlugins && agentConfig.type === "opencode") {
    console.log("OpenCode plugins: non-auth plugins disabled");
  }
  if (allowAllPermissions) console.log("Permissions: auto-approve all tools");
  if (logFilePath) console.log(`Log file: ${logFilePath}`);
  console.log("");
  console.log("Starting loop... (Ctrl+C to stop)");
  console.log("═".repeat(68));

  // Track current subprocess for cleanup on SIGINT
  let currentProc: ReturnType<typeof Bun.spawn> | null = null;

  // Set up signal handler for graceful shutdown
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) {
      console.log("\nForce stopping...");
      process.exit(1);
    }
    stopping = true;
    console.log("\nGracefully stopping Ralph loop...");

    // Kill the subprocess if it's running
    if (currentProc) {
      try {
        currentProc.kill();
      } catch {
        // Process may have already exited
      }
    }

    clearState();
    console.log("Loop cancelled.");
    process.exit(0);
  });

  // Main loop
  while (true) {
    // Check max iterations
    if (maxIterations > 0 && state.iteration > maxIterations) {
      console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
      console.log(`║  Max iterations (${maxIterations}) reached. Loop stopped.`);
      console.log(`║  Total time: ${formatDurationLong(history.totalDurationMs)}`);
      console.log(`╚══════════════════════════════════════════════════════════════════╝`);
      clearState();
      // Keep history for analysis via --status
      break;
    }

    const iterInfo = maxIterations > 0 ? ` / ${maxIterations}` : "";
    console.log(`\n🔄 Iteration ${state.iteration}${iterInfo}`);
    
    // Show structured task info if enabled
    if (state.structuredTasksFile) {
      const summary = getStructuredTasksSummary(state.milestoneFilter);
      const nextTask = getNextStructuredTask(state.milestoneFilter);
      console.log(`   Tasks: ${summary.completed}/${summary.total} complete | Next: ${nextTask?.id || "NONE"}`);
      if (nextTask) {
        console.log(`   "${nextTask.title}"`);
      }
    }
    console.log("─".repeat(68));

    // Capture context at start of iteration (to only clear what was consumed)
    const contextAtStart = loadContext();

    // Capture git state before iteration to detect per-iteration changes
    const snapshotBefore = await captureFileSnapshot();

    // Build the prompt
    const fullPrompt = buildPrompt(state, agentConfig);
    const iterationStart = Date.now();

    try {
      // Build command arguments (permission flags are handled inside buildArgs)
      const cmdArgs = agentConfig.buildArgs(fullPrompt, model, { allowAllPermissions });

      const env = agentConfig.buildEnv({
        filterPlugins: disablePlugins,
        allowAllPermissions: allowAllPermissions,
      });

      // Run agent using spawn for better argument handling
      // stdin is inherited so users can respond to permission prompts if needed
      currentProc = Bun.spawn([agentConfig.command, ...cmdArgs], {
        env,
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
      });
      const proc = currentProc;
      const exitCodePromise = proc.exited;
      let result = "";
      let stderr = "";
      let toolCounts = new Map<string, number>();

      if (streamOutput) {
        console.log("⏳ Starting agent...");
        const streamed = await streamProcessOutput(proc, {
          compactTools: !verboseTools,
          toolSummaryIntervalMs: 3000,
          heartbeatIntervalMs: 10000,
          iterationStart,
          agent: agentConfig,
        });
        result = streamed.stdoutText;
        stderr = streamed.stderrText;
        toolCounts = streamed.toolCounts;
      } else {
        const stdoutPromise = new Response(proc.stdout).text();
        const stderrPromise = new Response(proc.stderr).text();
        [result, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
        toolCounts = collectToolSummaryFromText(`${result}\n${stderr}`, agentConfig);
      }

      const exitCode = await exitCodePromise;
      currentProc = null; // Clear reference after subprocess completes

      if (!streamOutput) {
        if (stderr) {
          console.error(stderr);
        }
        console.log(result);
      }

      const combinedOutput = `${result}\n${stderr}`;
      const completionDetected = checkCompletion(combinedOutput, completionPromise);
      const taskCompletionDetected = tasksMode ? checkCompletion(combinedOutput, taskPromise) : false;

      // Parse and save any suggested tasks
      const suggestedTasks = parseSuggestedTasks(combinedOutput);
      if (suggestedTasks.length > 0) {
        appendSuggestedTasks(suggestedTasks, state.iteration);
      }

      const iterationDuration = Date.now() - iterationStart;

      printIterationSummary({
        iteration: state.iteration,
        elapsedMs: iterationDuration,
        toolCounts,
        exitCode,
        completionDetected,
      });

      // Track iteration history - compare against pre-iteration snapshot
      const snapshotAfter = await captureFileSnapshot();
      const filesModified = getModifiedFilesSinceSnapshot(snapshotBefore, snapshotAfter);
      const errors = extractErrors(combinedOutput);

      const iterationRecord: IterationHistory = {
        iteration: state.iteration,
        startedAt: new Date(iterationStart).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: iterationDuration,
        toolsUsed: Object.fromEntries(toolCounts),
        filesModified,
        exitCode,
        completionDetected,
        errors,
      };

      history.iterations.push(iterationRecord);
      history.totalDurationMs += iterationDuration;

      // Update struggle indicators
      if (filesModified.length === 0) {
        history.struggleIndicators.noProgressIterations++;
      } else {
        history.struggleIndicators.noProgressIterations = 0; // Reset on progress
      }

      if (iterationDuration < 30000) { // Less than 30 seconds
        history.struggleIndicators.shortIterations++;
      } else {
        history.struggleIndicators.shortIterations = 0; // Reset on normal-length iteration
      }

      if (errors.length === 0) {
        // Reset error tracking when iteration has no errors (issue resolved)
        history.struggleIndicators.repeatedErrors = {};
      } else {
        for (const error of errors) {
          const key = error.substring(0, 100);
          history.struggleIndicators.repeatedErrors[key] = (history.struggleIndicators.repeatedErrors[key] || 0) + 1;
        }
      }

      saveHistory(history);

      // Show struggle warning if detected
      const struggle = history.struggleIndicators;
      if (state.iteration > 2 && (struggle.noProgressIterations >= 3 || struggle.shortIterations >= 3)) {
        console.log(`\n⚠️  Potential struggle detected:`);
        if (struggle.noProgressIterations >= 3) {
          console.log(`   - No file changes in ${struggle.noProgressIterations} iterations`);
        }
        if (struggle.shortIterations >= 3) {
          console.log(`   - ${struggle.shortIterations} very short iterations`);
        }
        console.log(`   💡 Tip: Use 'ralph --add-context "hint"' in another terminal to guide the agent`);
      }

      if (agentType === "opencode" && detectPlaceholderPluginError(combinedOutput)) {
        console.error(
          "\n❌ OpenCode tried to load the legacy 'ralph-wiggum' plugin. This package is CLI-only.",
        );
        console.error(
          "Remove 'ralph-wiggum' from your opencode.json plugin list, or re-run with --no-plugins.",
        );
        clearState();
        process.exit(1);
      }

      if (exitCode !== 0) {
        console.warn(`\n⚠️  ${agentConfig.configName} exited with code ${exitCode}. Continuing to next iteration.`);
      }

      // Check for task completion (tasks mode only)
      if (taskCompletionDetected && !completionDetected) {
        console.log(`\n🔄 Task completion detected: <promise>${taskPromise}</promise>`);
        console.log(`   Moving to next task in iteration ${state.iteration + 1}...`);
      }

      // Check for full completion
      if (completionDetected) {
        console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
        console.log(`║  ✅ Completion promise detected: <promise>${completionPromise}</promise>`);
        console.log(`║  Task completed in ${state.iteration} iteration(s)`);
        console.log(`║  Total time: ${formatDurationLong(history.totalDurationMs)}`);
        console.log(`╚══════════════════════════════════════════════════════════════════╝`);
        clearState();
        clearHistory();
        clearContext();
        break;
      }

      // Clear context only if it was present at iteration start (preserve mid-iteration additions)
      if (contextAtStart) {
        console.log(`📝 Context was consumed this iteration`);
        clearContext();
      }

      // Auto-commit if enabled
      if (autoCommit) {
        try {
          // Check if there are changes to commit
          const status = await $`git status --porcelain`.text();
          if (status.trim()) {
            await $`git add -A`;
            await $`git commit -m "Ralph iteration ${state.iteration}: work in progress"`.quiet();
            console.log(`📝 Auto-committed changes`);
          }
        } catch {
          // Git commit failed, that's okay
        }
      }

      // Update state for next iteration
      state.iteration++;
      saveState(state);

      // Small delay between iterations
      await new Promise(r => setTimeout(r, 1000));

    } catch (error) {
      // Kill subprocess if still running to prevent orphaned processes
      if (currentProc) {
        try {
          currentProc.kill();
        } catch {
          // Process may have already exited
        }
        currentProc = null;
      }
      console.error(`\n❌ Error in iteration ${state.iteration}:`, error);
      console.log("Continuing to next iteration...");

      // Track failed iteration in history to keep state/history in sync
      const iterationDuration = Date.now() - iterationStart;
      const errorRecord: IterationHistory = {
        iteration: state.iteration,
        startedAt: new Date(iterationStart).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: iterationDuration,
        toolsUsed: {},
        filesModified: [],
        exitCode: -1,
        completionDetected: false,
        errors: [String(error).substring(0, 200)],
      };
      history.iterations.push(errorRecord);
      history.totalDurationMs += iterationDuration;
      saveHistory(history);

      state.iteration++;
      saveState(state);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Wait for worktree setup then run the loop
worktreeSetupPromise
  .then(() => runRalphLoop())
  .catch(error => {
    console.error("Fatal error:", error);
    clearState();
    process.exit(1);
  });
