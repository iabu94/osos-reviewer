import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, migrate } from "./client.js";
import {
  claimReview,
  getReviewByIdempotencyKey,
  markReviewRunning,
} from "./reviews.js";
import { ensureDatabase, resolveTestDatabaseUrl } from "./testing.js";
import type { Pool } from "pg";

const url = resolveTestDatabaseUrl();
const describeDb = url ? describe : describe.skip;

describeDb("reviews lifecycle store", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureDatabase(url!);
    pool = createPool(url!);
    await migrate(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE reviews");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("claimReview is idempotent on duplicate key", async () => {
    const a = await claimReview(pool, {
      reviewId: "r1",
      idempotencyKey: "act-1",
      prUrl: "https://github.com/o/r/pull/1",
      teamsConversationRef: null,
    });
    const b = await claimReview(pool, {
      reviewId: "r2",
      idempotencyKey: "act-1",
      prUrl: "https://github.com/o/r/pull/1",
      teamsConversationRef: null,
    });
    expect(a.kind).toBe("created");
    expect(b.kind).toBe("existing");
    expect(b.reviewId).toBe("r1");
  });

  it("markReviewRunning increments attempt_count", async () => {
    await claimReview(pool, {
      reviewId: "r3",
      idempotencyKey: "act-3",
      prUrl: "https://github.com/o/r/pull/3",
      teamsConversationRef: null,
    });
    await markReviewRunning(pool, "r3");
    await markReviewRunning(pool, "r3");
    const row = await getReviewByIdempotencyKey(pool, "act-3");
    expect(row?.attempt_count).toBe(2);
    expect(row?.status).toBe("running");
  });
});