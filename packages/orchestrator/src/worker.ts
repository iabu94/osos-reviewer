import { randomUUID } from "node:crypto";
import {
  claimReview,
  createPool,
  markReviewFinished,
  markReviewRunning,
} from "@review/db";

type ReviewDbPool = ReturnType<typeof createPool>;
import { buildReviewAdaptiveCard } from "@review/teams";
import type { AppConfig, ReviewResult, TeamsConversationRef } from "@review/shared";
import type { TeamsMessenger } from "@review/teams";
import type { ReviewLogger } from "./log.js";
import { createLogger } from "./log.js";
import type { ReviewDeps } from "./review.js";
import { runReview } from "./review.js";

const RETRYABLE_CODES = new Set([
  "claude_timeout",
  "db_unhealthy",
  "teams_delivery_failed",
]);

const TERMINAL_DUPLICATE_STATUSES = new Set([
  "accepted",
  "running",
  "completed",
  "failed",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 5000);
}

class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.available = max;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.available--;
  }

  release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

export type ReviewWorkerDeps = {
  pool: ReviewDbPool;
  config: AppConfig;
  messenger: TeamsMessenger;
  runReview: typeof runReview;
  buildReviewDeps: (prUrl: string) => Promise<ReviewDeps>;
  logger?: ReviewLogger;
  maxConcurrent?: number;
  retryMax?: number;
};

export type EnqueueInput = {
  prUrl: string;
  idempotencyKey: string;
  teamsConversationRef: TeamsConversationRef;
  reviewId?: string;
};

export type ReviewWorker = {
  enqueue: (
    input: EnqueueInput,
  ) => Promise<{ reviewId: string; duplicated: boolean }>;
  drain: () => Promise<void>;
};

export function createReviewWorker(deps: ReviewWorkerDeps): ReviewWorker {
  const maxConcurrent = deps.maxConcurrent ?? deps.config.maxConcurrentReviews;
  const retryMax = deps.retryMax ?? deps.config.reviewRetryMax;
  const logger = deps.logger ?? createLogger();
  const semaphore = new Semaphore(maxConcurrent);
  const inFlight = new Set<Promise<void>>();

  const runJob = async (
    reviewId: string,
    prUrl: string,
    teamsConversationRef: TeamsConversationRef,
  ) => {
    await semaphore.acquire();
    try {
      let last: ReviewResult | undefined;
      for (let attempt = 0; attempt <= retryMax; attempt++) {
        await markReviewRunning(deps.pool, reviewId);
        last = await deps.runReview(
          { prUrl, reviewId, teamsConversationRef },
          await deps.buildReviewDeps(prUrl),
        );

        try {
          await deps.messenger.reply(
            teamsConversationRef,
            buildReviewAdaptiveCard(last),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          last = {
            ...last,
            status: "failed",
            error: { code: "teams_delivery_failed", message },
          };
        }

        if (last.status === "completed") {
          break;
        }
        const code = last.error?.code;
        if (!code || !RETRYABLE_CODES.has(code)) {
          break;
        }
        if (attempt < retryMax) {
          await sleep(backoffMs(attempt));
        }
      }
      await markReviewFinished(deps.pool, reviewId, last!);
    } catch (err) {
      logger.error("review job failed", {
        reviewId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      semaphore.release();
    }
  };

  const schedule = (
    reviewId: string,
    prUrl: string,
    teamsConversationRef: TeamsConversationRef,
  ) => {
    const job = runJob(reviewId, prUrl, teamsConversationRef).finally(() => {
      inFlight.delete(job);
    });
    inFlight.add(job);
  };

  return {
    async enqueue(input) {
      const reviewId =
        input.reviewId ?? randomUUID().replace(/-/g, "");
      const claimed = await claimReview(deps.pool, {
        reviewId,
        idempotencyKey: input.idempotencyKey,
        prUrl: input.prUrl,
        teamsConversationRef: input.teamsConversationRef,
      });

      if (
        claimed.kind === "existing" &&
        TERMINAL_DUPLICATE_STATUSES.has(claimed.status)
      ) {
        return { reviewId: claimed.reviewId, duplicated: true };
      }

      const effectiveReviewId =
        claimed.kind === "existing" ? claimed.reviewId : claimed.reviewId;
      schedule(effectiveReviewId, input.prUrl, input.teamsConversationRef);
      return { reviewId: effectiveReviewId, duplicated: false };
    },

    async drain() {
      await Promise.all([...inFlight]);
    },
  };
}