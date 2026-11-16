import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

const ALLOWED_TOOLS = [
  "trace_fe_be_integration",
  "trace_symbol_impact",
  "check_reusability",
  "get_coding_standards",
] as const;

export async function runClaudeReview(opts: {
  prompt: string;
  claudeCliPath: string;
  mcpServerCommand: string;
  mcpServerArgs: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const configDir = await mkdtemp(join(tmpdir(), "review-claude-"));
  try {
    // Flags: headless print mode. --output-format json when supported by installed CLI.
    const mcpConfig = {
      mcpServers: {
        review: {
          command: opts.mcpServerCommand,
          args: opts.mcpServerArgs,
        },
      },
      permissions: {
        allow: ALLOWED_TOOLS.map((t) => `mcp__review__${t}`),
        deny: ["Edit", "Write", "Bash", "NotebookEdit"],
      },
    };
    const configPath = join(configDir, "mcp.json");
    await writeFile(configPath, JSON.stringify(mcpConfig, null, 2));

    try {
      const result = await execa(
        opts.claudeCliPath,
        [
          "-p",
          "--output-format",
          "json",
          "--mcp-config",
          configPath,
          opts.prompt,
        ],
        {
          timeout: opts.timeoutMs,
          env: { ...process.env, ...opts.env },
          reject: false,
        },
      );

      const timedOut = result.timedOut === true;
      return {
        exitCode: timedOut ? 124 : (result.exitCode ?? 1),
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        timedOut,
      };
    } catch (err) {
      const e = err as { timedOut?: boolean; stdout?: string; stderr?: string; exitCode?: number };
      if (e.timedOut) {
        return {
          exitCode: 124,
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
          timedOut: true,
        };
      }
      throw err;
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}
