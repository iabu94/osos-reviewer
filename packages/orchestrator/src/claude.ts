import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

const ALLOWED_TOOLS = [
  "mcp__review__trace_fe_be_integration",
  "mcp__review__trace_symbol_impact",
  "mcp__review__check_reusability",
  "mcp__review__get_coding_standards",
] as const;

const DISALLOWED_TOOLS = [
  "Edit",
  "Write",
  "Bash",
  "NotebookEdit",
] as const;

export async function runClaudeReview(opts: {
  prompt: string;
  claudeCliPath: string;
  mcpServerCommand: string;
  mcpServerArgs: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  addDirs?: string[];
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const configDir = await mkdtemp(join(tmpdir(), "review-claude-"));
  try {
    // Verified against Claude CLI help: --mcp-config loads servers only;
    // tool allow/deny must use --allowedTools / --disallowedTools; --strict-mcp-config
    // prevents loading the operator's other MCP servers.
    const mcpConfig = {
      mcpServers: {
        review: {
          command: opts.mcpServerCommand,
          args: opts.mcpServerArgs,
        },
      },
    };
    const configPath = join(configDir, "mcp.json");
    await writeFile(configPath, JSON.stringify(mcpConfig, null, 2));

    const args = [
      "-p",
      "--output-format",
      "json",
      "--mcp-config",
      configPath,
      "--strict-mcp-config",
      "--allowedTools",
      ALLOWED_TOOLS.join(","),
      "--disallowedTools",
      DISALLOWED_TOOLS.join(","),
    ];

    for (const dir of opts.addDirs ?? []) {
      args.push("--add-dir", dir);
    }

    try {
      const result = await execa(opts.claudeCliPath, args, {
        timeout: opts.timeoutMs,
        env: { ...process.env, ...opts.env },
        cwd: opts.cwd,
        input: opts.prompt,
        reject: false,
      });

      const timedOut = result.timedOut === true;
      return {
        exitCode: timedOut ? 124 : (result.exitCode ?? 1),
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        timedOut,
      };
    } catch (err) {
      const e = err as {
        timedOut?: boolean;
        stdout?: string;
        stderr?: string;
        exitCode?: number;
        message?: string;
      };
      if (e.timedOut) {
        return {
          exitCode: 124,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
          timedOut: true,
        };
      }
      return {
        exitCode: 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "claude spawn failed",
        timedOut: false,
      };
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}
