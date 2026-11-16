import { z } from "zod";
import { ConfigError } from "./errors.js";
import type { AppConfig, RepoConfig } from "./types.js";

const DEFAULT_TICKET_PATTERN = "[A-Z]+-\\d+";
const DEFAULT_FALLBACK = "origin/develop";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CLAUDE = "claude";

const repoSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["backend", "frontend"]),
  localPath: z.string().min(1),
  remoteUrl: z.string().optional(),
  defaultBaseBranch: z.string().min(1),
  githubRepo: z.string().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new ConfigError("DATABASE_URL is required");
  }

  const worktreeRoot = env.WORKTREE_ROOT;
  if (!worktreeRoot) {
    throw new ConfigError("WORKTREE_ROOT is required");
  }

  if (!env.REPOS_JSON) {
    throw new ConfigError("REPOS_JSON is required");
  }

  let reposRaw: unknown;
  try {
    reposRaw = JSON.parse(env.REPOS_JSON);
  } catch {
    throw new ConfigError("REPOS_JSON must be valid JSON");
  }

  const parsed = z.array(repoSchema).safeParse(reposRaw);
  if (!parsed.success) {
    throw new ConfigError(`REPOS_JSON invalid: ${parsed.error.message}`);
  }

  const repos: RepoConfig[] = parsed.data;
  const patternSource = env.TICKET_PATTERN ?? DEFAULT_TICKET_PATTERN;

  return {
    databaseUrl,
    worktreeRoot,
    claudeCliPath: env.CLAUDE_CLI_PATH ?? DEFAULT_CLAUDE,
    ticketPattern: new RegExp(patternSource),
    repos,
    companionFallbackBranch:
      env.COMPANION_FALLBACK_BRANCH ?? DEFAULT_FALLBACK,
    reviewTimeoutMs: env.REVIEW_TIMEOUT_MS
      ? Number(env.REVIEW_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS,
  };
}
