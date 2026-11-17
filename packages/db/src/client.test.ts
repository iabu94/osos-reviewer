import { describe, it, expect } from "vitest";
import { createPool, healthCheck, migrate } from "./client.js";
import { ensureDatabase, resolveTestDatabaseUrl } from "./testing.js";

const url = resolveTestDatabaseUrl();
const describeDb = url ? describe : describe.skip;

describeDb("db health", () => {
  it("connects and reports vector extension after migrate", async () => {
    await ensureDatabase(url!);
    const pool = createPool(url!);
    await migrate(pool);
    const result = await healthCheck(pool);
    expect(result).toEqual({ ok: true, vector: true });
    await pool.end();
  });

  it("migrate creates document_chunks with vector(768) and embedding_model", async () => {
    await ensureDatabase(url!);
    const pool = createPool(url!);
    await migrate(pool);
    const { rows } = await pool.query(`
    SELECT column_name, udt_name
    FROM information_schema.columns
    WHERE table_name = 'document_chunks'
      AND column_name IN ('embedding', 'embedding_model')
    ORDER BY column_name
  `);
    expect(rows.map((r) => r.column_name)).toEqual([
      "embedding",
      "embedding_model",
    ]);
    expect(rows[0]?.udt_name).toBe("vector");
    await pool.end();
  });
});

describe("resolveTestDatabaseUrl", () => {
  it("returns undefined when TEST_DATABASE_URL is unset (never DATABASE_URL)", () => {
    expect(
      resolveTestDatabaseUrl({ DATABASE_URL: "postgres://a@h:1/real" }),
    ).toBeUndefined();
  });

  it("refuses a test URL that points at the real database", () => {
    expect(() =>
      resolveTestDatabaseUrl({
        DATABASE_URL: "postgres://u:p@localhost:5433/review",
        TEST_DATABASE_URL: "postgres://x:y@localhost:5433/review",
      }),
    ).toThrow(/must differ/);
  });

  it("accepts a different database on the same server", () => {
    const test = "postgres://u:p@localhost:5433/review_test";
    expect(
      resolveTestDatabaseUrl({
        DATABASE_URL: "postgres://u:p@localhost:5433/review",
        TEST_DATABASE_URL: test,
      }),
    ).toBe(test);
  });
});
