import { z } from "zod";
import { ConfigError } from "./errors.js";
import type { AppConfig, RepoConfig } from "./types.js";

const DEFAULT_TICKET_PATTERN = "[A-Z]+-\\d+";
const DEFAULT_FALLBACK = "origin/develop";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CLAUDE = "claude";
const DEFAULT_KNOWLEDGE_BASE_PATH = "knowledge-base";
const DEFAULT_EMBEDDING_PROVIDER = "openai_compatible";
const DEFAULT_EMBEDDING_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_TEAMS_WEBHOOK_PORT = 3080;
const DEFAULT_MAX_CONCURRENT_REVIEWS = 2;
const DEFAULT_REVIEW_RETRY_MAX = 2;

function requireTeamsEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  label: string,
): string {
  const value = env[key];
  if (!value) {
    throw new ConfigError(`${label} is required when REQUIRE_TEAMS is true`);
  }
  return value;
}

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
  const embeddingProvider =
    env.EMBEDDING_PROVIDER ?? DEFAULT_EMBEDDING_PROVIDER;

  if (
    embeddingProvider !== "openai_compatible" &&
    embeddingProvider !== "fake"
  ) {
    throw new ConfigError(
      "EMBEDDING_PROVIDER must be openai_compatible or fake",
    );
  }

  if (embeddingProvider === "openai_compatible" && !env.EMBEDDING_API_KEY) {
    throw new ConfigError(
      "EMBEDDING_API_KEY is required when EMBEDDING_PROVIDER is openai_compatible",
    );
  }

  const requireTeams = env.REQUIRE_TEAMS === "true";
  const teamsWebhookSecret = requireTeams
    ? requireTeamsEnv(env, "TEAMS_WEBHOOK_SECRET", "TEAMS_WEBHOOK_SECRET")
    : (env.TEAMS_WEBHOOK_SECRET ?? "");
  const teamsBotAppId = requireTeams
    ? requireTeamsEnv(env, "TEAMS_BOT_APP_ID", "TEAMS_BOT_APP_ID")
    : (env.TEAMS_BOT_APP_ID ?? "");
  const teamsBotPassword = requireTeams
    ? requireTeamsEnv(env, "TEAMS_BOT_PASSWORD", "TEAMS_BOT_PASSWORD")
    : (env.TEAMS_BOT_PASSWORD ?? "");

  const teamsPort = env.TEAMS_WEBHOOK_PORT
    ? Number(env.TEAMS_WEBHOOK_PORT)
  : DEFAULT_TEAMS_WEBHOOK_PORT;
  const maxConcurrentReviews = env.MAX_CONCURRENT_REVIEWS
    ? Number(env.MAX_CONCURRENT_REVIEWS)
    : DEFAULT_MAX_CONCURRENT_REVIEWS;
  const reviewRetryMax = env.REVIEW_RETRY_MAX
    ? Number(env.REVIEW_RETRY_MAX)
    : DEFAULT_REVIEW_RETRY_MAX;

  return {
    databaseUrl,
    worktreeRoot,
    claudeCliPath: env.CLAUDE_CLI_PATH ?? DEFAULT_CLAUDE,
    knowledgeBasePath:
      env.KNOWLEDGE_BASE_PATH ?? DEFAULT_KNOWLEDGE_BASE_PATH,
    embedding: {
      provider: embeddingProvider,
      baseUrl: env.EMBEDDING_BASE_URL ?? DEFAULT_EMBEDDING_BASE_URL,
      apiKey: env.EMBEDDING_API_KEY,
      model: env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
      dimensions: 768,
    },
    ticketPattern: new RegExp(patternSource),
    repos,
    companionFallbackBranch:
      env.COMPANION_FALLBACK_BRANCH ?? DEFAULT_FALLBACK,
    reviewTimeoutMs: env.REVIEW_TIMEOUT_MS
      ? Number(env.REVIEW_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS,
    teams: {
      webhookSecret: teamsWebhookSecret,
      botAppId: teamsBotAppId,
      botPassword: teamsBotPassword,
      port: teamsPort,
    },
    githubToken: env.GITHUB_TOKEN || undefined,
    maxConcurrentReviews,
    reviewRetryMax,
  };
}
