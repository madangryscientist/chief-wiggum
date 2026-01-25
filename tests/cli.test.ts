import { describe, expect, test } from "bun:test";

interface ParsedArgs {
  command: string;
  args: string[];
  flags: Record<string, string | boolean>;
}

type FlagDef = { key: string; hasValue: boolean; default?: string };

const FLAG_DEFS: Record<string, FlagDef> = {
  "-h": { key: "help", hasValue: false },
  "--help": { key: "help", hasValue: false },
  "-V": { key: "version", hasValue: false },
  "--version": { key: "version", hasValue: false },
  "-f": { key: "prompt", hasValue: true },
  "--prompt": { key: "prompt", hasValue: true },
  "-n": { key: "iterations", hasValue: true, default: "0" },
  "--iterations": { key: "iterations", hasValue: true, default: "0" },
  "-m": { key: "model", hasValue: true },
  "--model": { key: "model", hasValue: true },
  "-a": { key: "agent", hasValue: true },
  "--agent": { key: "agent", hasValue: true },
  "-t": { key: "tasksFile", hasValue: true },
  "--tasks-file": { key: "tasksFile", hasValue: true },
  "-M": { key: "milestone", hasValue: true },
  "--milestone": { key: "milestone", hasValue: true },
  "-w": { key: "workspace", hasValue: true },
  "--workspace": { key: "workspace", hasValue: true },
  "--repo": { key: "repo", hasValue: true },
  "-b": { key: "branch", hasValue: true },
  "--branch": { key: "branch", hasValue: true },
  "--done": { key: "done", hasValue: true },
  "--next": { key: "next", hasValue: true },
  "--timeout": { key: "timeout", hasValue: true, default: "30" },
  "--force": { key: "force", hasValue: false },
  "-v": { key: "verbose", hasValue: false },
  "--verbose": { key: "verbose", hasValue: false },
  "-q": { key: "quiet", hasValue: false },
  "--quiet": { key: "quiet", hasValue: false },
  "--no-commit": { key: "noCommit", hasValue: false },
  "-i": { key: "interactive", hasValue: false },
  "--interactive": { key: "interactive", hasValue: false },
  "--no-plugins": { key: "noPlugins", hasValue: false },
  "--log": { key: "log", hasValue: false },
  "--clear": { key: "clear", hasValue: false },
};

const COMMANDS = ["run", "status", "context", "tasks"];

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: "", args: [], flags: {} };

  if (argv.length > 0 && COMMANDS.includes(argv[0])) {
    result.command = argv[0];
    argv = argv.slice(1);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const def = FLAG_DEFS[arg];

    if (def) {
      result.flags[def.key] = def.hasValue ? (argv[++i] ?? def.default ?? "") : true;
    } else if (!arg.startsWith("-")) {
      result.args.push(arg);
    }
  }

  return result;
}

describe("parseArgs", () => {
  test("parses run command", () => {
    const result = parseArgs(["run", "-f", "prompt.md"]);
    expect(result.command).toBe("run");
    expect(result.flags.prompt).toBe("prompt.md");
  });

  test("parses status command", () => {
    const result = parseArgs(["status"]);
    expect(result.command).toBe("status");
  });

  test("parses context command with args", () => {
    const result = parseArgs(["context", "some", "context", "text"]);
    expect(result.command).toBe("context");
    expect(result.args).toEqual(["some", "context", "text"]);
  });

  test("parses tasks command", () => {
    const result = parseArgs(["tasks", "add", "new task"]);
    expect(result.command).toBe("tasks");
    expect(result.args).toEqual(["add", "new task"]);
  });

  test("parses short flags", () => {
    const result = parseArgs(["-f", "prompt.md", "-n", "10", "-m", "gpt-4", "-v"]);
    expect(result.flags.prompt).toBe("prompt.md");
    expect(result.flags.iterations).toBe("10");
    expect(result.flags.model).toBe("gpt-4");
    expect(result.flags.verbose).toBe(true);
  });

  test("parses long flags", () => {
    const result = parseArgs([
      "--prompt", "prompt.md",
      "--iterations", "5",
      "--model", "claude-3",
      "--verbose",
      "--force",
    ]);
    expect(result.flags.prompt).toBe("prompt.md");
    expect(result.flags.iterations).toBe("5");
    expect(result.flags.model).toBe("claude-3");
    expect(result.flags.verbose).toBe(true);
    expect(result.flags.force).toBe(true);
  });

  test("parses milestone flag", () => {
    const result = parseArgs(["-M", "M2b", "-t", "docs/tasks.md"]);
    expect(result.flags.milestone).toBe("M2b");
    expect(result.flags.tasksFile).toBe("docs/tasks.md");
  });

  test("parses help flag", () => {
    const result = parseArgs(["--help"]);
    expect(result.flags.help).toBe(true);
  });

  test("parses version flag", () => {
    const result = parseArgs(["-V"]);
    expect(result.flags.version).toBe(true);
  });

  test("parses boolean flags", () => {
    const result = parseArgs(["--force", "--verbose", "--quiet", "--no-commit", "--interactive", "--no-plugins", "--log"]);
    expect(result.flags.force).toBe(true);
    expect(result.flags.verbose).toBe(true);
    expect(result.flags.quiet).toBe(true);
    expect(result.flags.noCommit).toBe(true);
    expect(result.flags.interactive).toBe(true);
    expect(result.flags.noPlugins).toBe(true);
    expect(result.flags.log).toBe(true);
  });

  test("parses timeout flag", () => {
    const result = parseArgs(["--timeout", "60"]);
    expect(result.flags.timeout).toBe("60");
  });

  test("parses workspace and repo flags", () => {
    const result = parseArgs(["-w", "/path/to/workspace", "--repo", "/path/to/repo", "-b", "feature-branch"]);
    expect(result.flags.workspace).toBe("/path/to/workspace");
    expect(result.flags.repo).toBe("/path/to/repo");
    expect(result.flags.branch).toBe("feature-branch");
  });

  test("parses agent flag", () => {
    const result = parseArgs(["-a", "claude-code"]);
    expect(result.flags.agent).toBe("claude-code");
  });

  test("parses done and next flags", () => {
    const result = parseArgs(["--done", "FINISHED", "--next", "CONTINUE"]);
    expect(result.flags.done).toBe("FINISHED");
    expect(result.flags.next).toBe("CONTINUE");
  });

  test("handles empty args", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("");
    expect(result.args).toEqual([]);
    expect(result.flags).toEqual({});
  });

  test("collects positional args", () => {
    const result = parseArgs(["run", "inline", "prompt", "text"]);
    expect(result.command).toBe("run");
    expect(result.args).toEqual(["inline", "prompt", "text"]);
  });
});
