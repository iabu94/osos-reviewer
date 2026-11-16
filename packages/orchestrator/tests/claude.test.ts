import { describe, it, expect, beforeAll } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeReview } from "../src/claude.js";

describe("runClaudeReview", () => {
  let binDir: string;
  let okCli: string;
  let slowCli: string;
  let argvFile: string;

  beforeAll(async () => {
    binDir = await mkdtemp(join(tmpdir(), "fake-claude-"));
    argvFile = join(binDir, "argv.txt");
    okCli = join(binDir, "claude-ok");
    slowCli = join(binDir, "claude-slow");

    await writeFile(
      okCli,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\necho '{"ok":true}'\n`,
    );
    await writeFile(
      slowCli,
      `#!/bin/sh\nsleep 2\necho '{"ok":true}'\n`,
    );
    await chmod(okCli, 0o755);
    await chmod(slowCli, 0o755);
  });

  it("invokes CLI with -p, restricted tools, and prompt on stdin", async () => {
    const result = await runClaudeReview({
      prompt: "review this UNIQUE_PROMPT",
      claudeCliPath: okCli,
      mcpServerCommand: "echo",
      mcpServerArgs: ["mcp"],
      timeoutMs: 5_000,
      cwd: binDir,
      addDirs: [binDir],
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain('{"ok":true}');
    const argv = await readFile(argvFile, "utf8");
    expect(argv).toContain("-p");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain("mcp__review__trace_fe_be_integration");
    expect(argv).toContain("--disallowedTools");
    expect(argv).not.toContain("UNIQUE_PROMPT");
    expect(argv).toContain("--add-dir");
  });

  it("sets timedOut when CLI exceeds timeout", async () => {
    const result = await runClaudeReview({
      prompt: "review this",
      claudeCliPath: slowCli,
      mcpServerCommand: "echo",
      mcpServerArgs: ["mcp"],
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
  });
});
