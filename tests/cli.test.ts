import { describe, expect, test } from "bun:test";

interface ParsedArgs {
  command: string;
  args: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: "", args: [], flags: {} };

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
    } else if (!arg.startsWith("-")) {
      result.args.push(arg);
    }
    i++;
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
