import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimReview,
  createPool,
  ensureDatabase,
  getReviewByIdempotencyKey,
  markReviewFinished,
  markReviewRunning,
  migrate,
  resolveTestDatabaseUrl,
} from "@review/db";
import { NO_FINDINGS_SUMMARY, type AppConfig, type TeamsConversationRef } from "@review/shared";
import { createFakeTeamsMessenger } from "@review/teams";
import type { Pool } from "pg";
import { GithubDeliveryError } from "../src/github-review.js";
import type { GithubReviewPoster } from "../src/github-review.js";
import { createReviewWorker } from "../src/worker.js";
import type { ReviewDeps } from "../src/review.js";

const url = resolveTestDatabaseUrl();
const describeDb = url ? describe : describe.skip;

const teamsConversationRef: TeamsConversationRef = {
  serviceUrl: "https://smba.trafficmanager.net/amer/",
  conversationId: "conv-1",
  activityId: "act-1",
};

const fakeDeps = {
  config: {} as AppConfig,
  claudeCliPath: "",
  mcpServerCommand: "",
  mcpServerArgs: [],
  getPrBranches: async () => ({
    primaryBranch: "feature/X-1",
    targetBranch: "main",
    headRef: "feature/X-1",
  }),
  listRemoteBranches: async () => ["main"],
} satisfies ReviewDeps;

const prUrl = "https://github.com/acme/be/pull/1";

function baseConfig(): AppConfig {
  return {
    databaseUrl: url ?? "postgres://localhost/test",
    worktreeRoot: "/tmp",
    claudeCliPath: "",
    knowledgeBasePath: "",
    embedding: { provider: "fake", model: "fake", dimensions: 768 },
    ticketPattern: /X-\d+/,
    repos: [],
    companionFallbackBranch: "main",
    reviewTimeoutMs: 1,
    teams: {
      webhookSecret: "s",
      replyFlowUrl: "",
      botAppId: "id",
      botPassword: "pw",
      port: 3978,
    },
    githubReviewDelivery: false,
    maxConcurrentReviews: 2,
    reviewRetryMax: 0,
  };
}

function trackingPoster(
  order: string[],
  impl?: GithubReviewPoster["postReview"],
): GithubReviewPoster {
  return {
    async postReview(input) {
      order.push("github");
      if (impl) {
        return impl(input);
      }
      return { status: "created" };
    },
  };
}

describeDb("createReviewWorker", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureDatabase(url!);
    pool = createPool(url!);
    await migrate(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE reviews");
    vi.useRealTimers();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("duplicate enqueue does not runReview twice", async () => {
    let runs = 0;
    const messenger = createFakeTeamsMessenger();
    const worker = createReviewWorker({
      pool,
      config: { ...baseConfig(), maxConcurrentReviews: 1, reviewRetryMax: 0 },
      messenger,
      runReview: async (req) => {
        runs++;
        return {
          reviewId: req.reviewId,
          status: "completed",
          report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
        };
      },
      buildReviewDeps: async () => fakeDeps,
      maxConcurrent: 1,
      retryMax: 0,
    });
    const a = await worker.enqueue({
      prUrl,
      idempotencyKey: "k1",
      teamsConversationRef,
    });
    const b = await worker.enqueue({
      prUrl,
      idempotencyKey: "k1",
      teamsConversationRef,
    });
    await worker.drain();
    expect(a.duplicated).toBe(false);
    expect(b.duplicated).toBe(true);
    expect(a.reviewId).toBe(b.reviewId);
    expect(runs).toBe(1);
    expect(messenger.sent).toHaveLength(1);
  });

  it("maxConcurrentReviews=1 serializes two jobs", async () => {
    let active = 0;
    let maxActive = 0;
    const gate1 = deferred<void>();
    const gate2 = deferred<void>();
    let job = 0;

    const messenger = createFakeTeamsMessenger();
    const worker = createReviewWorker({
      pool,
      config: baseConfig(),
      messenger,
      runReview: async (req) => {
        job++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (job === 1) {
          await gate1.promise;
        } else {
          await gate2.promise;
        }
        active--;
        return {
          reviewId: req.reviewId,
          status: "completed",
          report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
        };
      },
      buildReviewDeps: async () => fakeDeps,
      maxConcurrent: 1,
      retryMax: 0,
    });

    const e1 = worker.enqueue({
      prUrl,
      idempotencyKey: "serial-1",
      teamsConversationRef,
      reviewId: randomUUID().replace(/-/g, ""),
    });
    const e2 = worker.enqueue({
      prUrl,
      idempotencyKey: "serial-2",
      teamsConversationRef,
      reviewId: randomUUID().replace(/-/g, ""),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(maxActive).toBeLessThanOrEqual(1);
    gate1.resolve();
    await new Promise((r) => setTimeout(r, 50));
    gate2.resolve();
    await e1;
    await e2;
    await worker.drain();
    expect(maxActive).toBe(1);
  });

  it("retries teams_delivery_failed then succeeds", async () => {
    let reviewAttempts = 0;
    let replyAttempts = 0;
    const messenger = createFakeTeamsMessenger();
    const failingMessenger = {
      sent: messenger.sent,
      async reply(...args: Parameters<typeof messenger.reply>) {
        replyAttempts++;
        if (replyAttempts === 1) {
          throw new Error("delivery down");
        }
        return messenger.reply(...args);
      },
    };

    const worker = createReviewWorker({
      pool,
      config: baseConfig(),
      messenger: failingMessenger,
      runReview: async (req) => {
        reviewAttempts++;
        return {
          reviewId: req.reviewId,
          status: "completed",
          report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
        };
      },
      buildReviewDeps: async () => fakeDeps,
      maxConcurrent: 1,
      retryMax: 1,
    });

    const reviewId = randomUUID().replace(/-/g, "");
    await worker.enqueue({
      prUrl,
      idempotencyKey: "retry-teams",
      teamsConversationRef,
      reviewId,
    });
    await worker.drain();

    expect(reviewAttempts).toBe(2);
    expect(replyAttempts).toBe(2);
    expect(messenger.sent).toHaveLength(1);
    const row = await getReviewByIdempotencyKey(pool, "retry-teams");
    expect(row?.attempt_count).toBe(2);
    expect(row?.status).toBe("completed");
  });

  it("duplicate on failed prior review does not reschedule", async () => {
    const priorReviewId = "existing-failed";
    await claimReview(pool, {
      reviewId: priorReviewId,
      idempotencyKey: "dup-failed",
      prUrl,
      teamsConversationRef,
    });
    await markReviewRunning(pool, priorReviewId);
    await markReviewFinished(pool, priorReviewId, {
      reviewId: priorReviewId,
      status: "failed",
      error: { code: "claude_timeout", message: "prior run" },
    });

    let runs = 0;
    const worker = createReviewWorker({
      pool,
      config: baseConfig(),
      messenger: createFakeTeamsMessenger(),
      runReview: async () => {
        runs++;
        return {
          reviewId: priorReviewId,
          status: "completed",
          report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
        };
      },
      buildReviewDeps: async () => fakeDeps,
    });
    const result = await worker.enqueue({
      prUrl,
      idempotencyKey: "dup-failed",
      teamsConversationRef,
    });
    await worker.drain();
    expect(result.duplicated).toBe(true);
    expect(result.reviewId).toBe(priorReviewId);
    expect(runs).toBe(0);
    const row = await getReviewByIdempotencyKey(pool, "dup-failed");
    expect(row?.status).toBe("failed");
  });

  it("duplicate on completed prior review does not reschedule", async () => {
    const priorReviewId = "existing-completed";
    await claimReview(pool, {
      reviewId: priorReviewId,
      idempotencyKey: "dup-completed",
      prUrl,
      teamsConversationRef,
    });
    await markReviewRunning(pool, priorReviewId);
    await markReviewFinished(pool, priorReviewId, {
      reviewId: priorReviewId,
      status: "completed",
      report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
    });

    let runs = 0;
    const worker = createReviewWorker({
      pool,
      config: baseConfig(),
      messenger: createFakeTeamsMessenger(),
      runReview: async () => {
        runs++;
        return {
          reviewId: priorReviewId,
          status: "completed",
          report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
        };
      },
      buildReviewDeps: async () => fakeDeps,
    });
    const result = await worker.enqueue({
      prUrl,
      idempotencyKey: "dup-completed",
      teamsConversationRef,
    });
    await worker.drain();
    expect(result.duplicated).toBe(true);
    expect(runs).toBe(0);
  });

  it("unexpected buildReviewDeps error terminalizes row without rejecting drain", async () => {
    const reviewId = randomUUID().replace(/-/g, "");
    const worker = createReviewWorker({
      pool,
      config: baseConfig(),
      messenger: createFakeTeamsMessenger(),
      runReview: async () => {
        throw new Error("runReview should not be reached");
      },
      buildReviewDeps: async () => {
        throw new Error("github unavailable");
      },
    });
    await worker.enqueue({
      prUrl,
      idempotencyKey: "worker-error",
      teamsConversationRef,
      reviewId,
    });
    await expect(worker.drain()).resolves.toBeUndefined();
    const row = await getReviewByIdempotencyKey(pool, "worker-error");
    expect(row?.status).toBe("failed");
    expect(row?.error_code).toBe("worker_error");
    expect(row?.error_message).toContain("github unavailable");
  });

  it("logs review start and completion", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const reviewId = randomUUID().replace(/-/g, "");
    const worker = createReviewWorker({
      pool,
      config: { ...baseConfig(), reviewRetryMax: 0 },
      messenger: createFakeTeamsMessenger(),
      logger,
      runReview: async (req) => ({
        reviewId: req.reviewId,
        status: "completed",
        report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
      }),
      buildReviewDeps: async () => fakeDeps,
      maxConcurrent: 1,
      retryMax: 0,
    });
    await worker.enqueue({
      prUrl,
      idempotencyKey: "log-complete",
      teamsConversationRef,
      reviewId,
    });
    await worker.drain();
    expect(logger.info).toHaveBeenCalledWith(
      "review started",
      expect.objectContaining({ reviewId, prUrl }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "review finished",
      expect.objectContaining({ reviewId, status: "completed" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "teams reply sent",
      expect.objectContaining({ reviewId }),
    );
  });

  it("posts GitHub before Teams on completed review", async () => {
    const order: string[] = [];
    const messenger = createFakeTeamsMessenger();
    const wrappingMessenger = {
      sent: messenger.sent,
      async reply(...args: Parameters<typeof messenger.reply>) {
        order.push("teams");
        return messenger.reply(...args);
      },
    };
    const worker = createReviewWorker({
      pool,
      config: { ...baseConfig(), githubReviewDelivery: true, reviewRetryMax: 0 },
      messenger: wrappingMessenger,
      githubReviewPoster: trackingPoster(order),
      runReview: async (req) => ({
        reviewId: req.reviewId,
        status: "completed",
        report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
      }),
      buildReviewDeps: async () => fakeDeps,
      maxConcurrent: 1,
      retryMax: 0,
    });
    await worker.enqueue({
      prUrl,
      idempotencyKey: "gh-before-teams",
      teamsConversationRef,
      reviewId: randomUUID().replace(/-/g, ""),
    });
    await worker.drain();
    expect(order).toEqual(["github", "teams"]);
    expect(messenger.sent).toHaveLength(1);
  });

  it("skips GitHub when githubReviewDelivery false", async () => {
    let githubCalls = 0;
    const worker = createReviewWorker({
      pool,
      config: { ...baseConfig(), githubReviewDelivery: false, reviewRetryMax: 0 },
      messenger: createFakeTeamsMessenger(),
      githubReviewPoster: {
        async postReview() {
          githubCalls++;
          return { status: "created" };
        },
      },
      runReview: async (req) => ({
        reviewId: req.reviewId,
        status: "completed",
        report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
      }),
      buildReviewDeps: async () => fakeDeps,
      maxConcurrent: 1,
      retryMax: 0,
    });
    await worker.enqueue({
      prUrl,
      idempotencyKey: "gh-disabled",
      teamsConversationRef,
      reviewId: randomUUID().replace(/-/g, ""),
    });
    await worker.drain();
    expect(githubCalls).toBe(0);
  });

  it("retries github_delivery_failed without double post after success", async () => {
    let githubCalls = 0;
    let replyAttempts = 0;
    const messenger = createFakeTeamsMessenger();
    const failingMessenger = {
      sent: messenger.sent,
      async reply(...args: Parameters<typeof messenger.reply>) {
        replyAttempts++;
        if (replyAttempts === 1) {
          throw new Error("delivery down");
        }
        return messenger.reply(...args);
      },
    };
    const worker = createReviewWorker({
      pool,
      config: { ...baseConfig(), githubReviewDelivery: true, reviewRetryMax: 1 },
      messenger: failingMessenger,
      githubReviewPoster: {
        async postReview() {
          githubCalls++;
          return { status: "created" };
        },
      },
      runReview: async (req) => ({
        reviewId: req.reviewId,
        status: "completed",
        report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
      }),
      buildReviewDeps: async () => fakeDeps,
      maxConcurrent: 1,
      retryMax: 1,
    });
    await worker.enqueue({
      prUrl,
      idempotencyKey: "gh-once-teams-retry",
      teamsConversationRef,
      reviewId: randomUUID().replace(/-/g, ""),
    });
    await worker.drain();
    expect(githubCalls).toBe(1);
    expect(replyAttempts).toBe(2);
    expect(messenger.sent).toHaveLength(1);
  });

  it("does not post GitHub on retryable runReview failure until terminal", async () => {
    let githubCalls = 0;
    let reviewAttempts = 0;
    const worker = createReviewWorker({
      pool,
      config: { ...baseConfig(), githubReviewDelivery: true, reviewRetryMax: 1 },
      messenger: createFakeTeamsMessenger(),
      githubReviewPoster: {
        async postReview(input) {
          githubCalls++;
          expect(input.result.status).toBe("completed");
          return { status: "created" };
        },
      },
      runReview: async (req) => {
        reviewAttempts++;
        if (reviewAttempts === 1) {
          return {
            reviewId: req.reviewId,
            status: "failed",
            error: { code: "claude_timeout", message: "timeout" },
          };
        }
        return {
          reviewId: req.reviewId,
          status: "completed",
          report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
        };
      },
      buildReviewDeps: async () => fakeDeps,
      maxConcurrent: 1,
      retryMax: 1,
    });
    await worker.enqueue({
      prUrl,
      idempotencyKey: "gh-after-retryable",
      teamsConversationRef,
      reviewId: randomUUID().replace(/-/g, ""),
    });
    await worker.drain();
    expect(reviewAttempts).toBe(2);
    expect(githubCalls).toBe(1);
  });

  it("does not call Teams when GitHub fails on an attempt", async () => {
    const messenger = createFakeTeamsMessenger();
    const worker = createReviewWorker({
      pool,
      config: { ...baseConfig(), githubReviewDelivery: true, reviewRetryMax: 0 },
      messenger,
      githubReviewPoster: {
        async postReview() {
          throw new GithubDeliveryError("create review failed with status 500");
        },
      },
      runReview: async (req) => ({
        reviewId: req.reviewId,
        status: "completed",
        report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
      }),
      buildReviewDeps: async () => fakeDeps,
      maxConcurrent: 1,
      retryMax: 0,
    });
    const reviewId = randomUUID().replace(/-/g, "");
    await worker.enqueue({
      prUrl,
      idempotencyKey: "gh-fail-no-teams",
      teamsConversationRef,
      reviewId,
    });
    await worker.drain();
    expect(messenger.sent).toHaveLength(0);
    const row = await getReviewByIdempotencyKey(pool, "gh-fail-no-teams");
    expect(row?.status).toBe("failed");
    expect(row?.error_code).toBe("github_delivery_failed");
  });

  it("logs review failure with error code", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const reviewId = randomUUID().replace(/-/g, "");
    const worker = createReviewWorker({
      pool,
      config: { ...baseConfig(), reviewRetryMax: 0 },
      messenger: createFakeTeamsMessenger(),
      logger,
      runReview: async (req) => ({
        reviewId: req.reviewId,
        status: "failed",
        error: { code: "review_id_in_use", message: "dir exists" },
      }),
      buildReviewDeps: async () => fakeDeps,
      maxConcurrent: 1,
      retryMax: 0,
    });
    await worker.enqueue({
      prUrl,
      idempotencyKey: "log-fail",
      teamsConversationRef,
      reviewId,
    });
    await worker.drain();
    expect(logger.info).toHaveBeenCalledWith(
      "review started",
      expect.objectContaining({ reviewId }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "review finished",
      expect.objectContaining({
        reviewId,
        status: "failed",
        errorCode: "review_id_in_use",
      }),
    );
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}