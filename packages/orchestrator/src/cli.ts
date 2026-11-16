import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { loadConfig } from "@review/shared";
import { runReview } from "./review.js";

function usage(): never {
  console.error(
    "Usage: review --pr-url <url> [--review-id <id>] [--primary-branch <name>] [--target-branch <name>]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) usage();
      out[key] = val;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["pr-url"]) usage();

  const config = loadConfig(process.env);
  const reviewId = args["review-id"] ?? randomUUID().replace(/-/g, "");
  const primaryBranch = args["primary-branch"] ?? "HEAD";
  const targetBranch = args["target-branch"] ?? "develop";
  const headRef = args["primary-branch"] ?? primaryBranch;

  const mcpEntry = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../mcp-server/src/index.ts",
  );
  const tsxBin = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../node_modules/.bin/tsx",
  );

  const result = await runReview(
    { prUrl: args["pr-url"]!, reviewId },
    {
      config,
      requireDb: process.env.REQUIRE_DB === "true",
      claudeCliPath: config.claudeCliPath,
      mcpServerCommand: tsxBin,
      mcpServerArgs: [mcpEntry],
      getPrBranches: async () => ({
        primaryBranch,
        targetBranch,
        headRef,
      }),
      listRemoteBranches: async (repoPath) => {
        const { stdout } = await execa("git", ["branch", "-r"], {
          cwd: repoPath,
        });
        return stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
      },
    },
  );

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "completed" ? 0 : 1);
}

const entry = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entry && import.meta.url === entry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
