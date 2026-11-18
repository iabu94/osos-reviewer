import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { createPool, migrate, type Pool } from "@review/db";
import { loadConfig, type AppConfig } from "@review/shared";
import {
  createHttpTeamsMessenger,
  createPowerAutomateTeamsMessenger,
  type TeamsMessenger,
  type TeamsWebhookWorker,
} from "@review/teams";
import { createLogger } from "./log.js";
import { resolvePrBranchesViaGithub } from "./github-pr.js";
import { createGithubReviewPoster } from "./github-review.js";
import type { ReviewDeps } from "./review.js";
import { runReview } from "./review.js";
import { createReviewWorker, type ReviewWorker } from "./worker.js";

export type TeamsRuntime = {
  config: AppConfig;
  pool: Pool;
  worker: ReviewWorker & TeamsWebhookWorker;
  logger: ReturnType<typeof createLogger>;
  shutdown: () => Promise<void>;
};

function resolveTsxBin(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", "tsx");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("tsx binary not found in node_modules/.bin");
}

export function resolveMcpLaunch(): { command: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const mcpEntry = resolve(here, "../../mcp-server/src/index.ts");
  const tsxBin = resolveTsxBin(here);
  return { command: tsxBin, args: [mcpEntry] };
}

export async function createTeamsRuntime(
  env: NodeJS.ProcessEnv,
): Promise<TeamsRuntime> {
  const config = loadConfig({ ...env, REQUIRE_TEAMS: "true" });
  await mkdir(config.worktreeRoot, { recursive: true });
  const pool = createPool(config.databaseUrl);
  await migrate(pool);

  const logger = createLogger();
  logger.info("worktree root ready", { worktreeRoot: config.worktreeRoot });
  const messenger: TeamsMessenger = config.teams.replyFlowUrl
    ? createPowerAutomateTeamsMessenger({
        flowUrl: config.teams.replyFlowUrl,
      })
    : createHttpTeamsMessenger({
        appId: config.teams.botAppId,
        password: config.teams.botPassword,
      });

  const { command: mcpServerCommand, args: mcpServerArgs } = resolveMcpLaunch();

  const buildReviewDeps = async (_prUrl: string): Promise<ReviewDeps> => {
    return {
      config,
      requireDb: true,
      claudeCliPath: config.claudeCliPath,
      mcpServerCommand,
      mcpServerArgs,
      logger,
      getPrBranches: async (url) => {
        if (!config.githubToken) {
          throw new Error(
            "GITHUB_TOKEN is required to resolve pull request branches",
          );
        }
        return resolvePrBranchesViaGithub(url, { token: config.githubToken });
      },
      listRemoteBranches: async (repoPath) => {
        const { stdout } = await execa("git", ["branch", "-r"], {
          cwd: repoPath,
        });
        return stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
      },
    };
  };

  const githubReviewPoster =
    config.githubReviewDelivery && config.githubToken
      ? createGithubReviewPoster({ token: config.githubToken })
      : null;

  const worker = createReviewWorker({
    pool,
    config,
    messenger,
    runReview,
    buildReviewDeps,
    githubReviewPoster,
    logger,
  });

  const shutdown = async (): Promise<void> => {
    try {
      await worker.drain();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("worker drain failed during shutdown", { err: message });
    }
    await pool.end();
  };

  return { config, pool, worker, logger, shutdown };
}
