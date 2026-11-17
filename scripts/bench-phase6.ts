import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPool,
  ensureDatabase,
  migrate,
  resolveTestDatabaseUrl,
} from "../packages/db/src/index.js";
import {
  NO_FINDINGS_SUMMARY,
  type AppConfig,
  type ReviewResult,
  type TeamsConversationRef,
} from "../packages/shared/src/index.js";
import { createFakeTeamsMessenger } from "../packages/teams/src/messenger.js";
import { createReviewWorker } from "../packages/orchestrator/src/worker.js";
import type { ReviewDeps } from "../packages/orchestrator/src/review.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "bench-phase6-out.json");

const diagnostics = {
  durationMs: 12_345,
  inputTokens: 1000,
  outputTokens: 250,
};

const teamsRef: TeamsConversationRef = {
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  conversationId: "bench-conv",
  activityId: "bench-act",
};

function baseConfig(databaseUrl: string): AppConfig {
  return {
    databaseUrl,
    worktreeRoot: "/tmp",
    claudeCliPath: "claude",
    knowledgeBasePath: "knowledge-base",
    embedding: { provider: "fake", model: "fake", dimensions: 768 },
    ticketPattern: /X-\d+/,
    repos: [],
    companionFallbackBranch: "main",
    reviewTimeoutMs: 120_000,
    teams: {
      webhookSecret: "bench",
      botAppId: "bench",
      botPassword: "bench",
      port: 3080,
    },
    maxConcurrentReviews: 1,
    reviewRetryMax: 0,
  };
}

async function main(): Promise<void> {
  const url = resolveTestDatabaseUrl();
  if (!url) {
    throw new Error("TEST_DATABASE_URL is required for bench-phase6");
  }

  const wallStart = Date.now();
  await ensureDatabase(url);
  const pool = createPool(url);
  await migrate(pool);
  await pool.query("TRUNCATE TABLE reviews");

  const fakeResult: ReviewResult = {
    reviewId: "bench-review",
    status: "completed",
    report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
    diagnostics,
  };

  const runReview = async (): Promise<ReviewResult> => fakeResult;
  const buildReviewDeps = async (): Promise<ReviewDeps> => ({
    config: baseConfig(url),
    requireDb: true,
    claudeCliPath: "",
    mcpServerCommand: "echo",
    mcpServerArgs: [],
    getPrBranches: async () => ({
      primaryBranch: "feature",
      targetBranch: "main",
      headRef: "feature",
    }),
    listRemoteBranches: async () => ["origin/main"],
  });

  const worker = createReviewWorker({
    pool,
    config: baseConfig(url),
    messenger: createFakeTeamsMessenger(),
    runReview,
    buildReviewDeps,
    maxConcurrent: 1,
    retryMax: 0,
  });

  const prUrl = "https://github.com/acme/widgets/pull/1";
  await worker.enqueue({
    prUrl,
    idempotencyKey: "bench-key",
    teamsConversationRef: teamsRef,
    reviewId: "bench-review",
  });
  await worker.drain();
  await pool.end();

  const wallClockMs = Date.now() - wallStart;
  const payload = {
    durationMs: diagnostics.durationMs,
    inputTokens: diagnostics.inputTokens,
    outputTokens: diagnostics.outputTokens,
    wallClockMs,
  };

  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  if (wallClockMs > 30_000) {
    console.warn(
      `bench-phase6 wall clock ${wallClockMs}ms exceeds 30000ms (still exiting 0)`,
    );
  }
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});