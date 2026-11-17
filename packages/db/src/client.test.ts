import { describe, it, expect } from "vitest";
import { createPool, healthCheck, migrate } from "./client.js";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("db health", () => {
  it("connects and reports vector extension after migrate", async () => {
    const pool = createPool(url!);
    await migrate(pool);
    const result = await healthCheck(pool);
    expect(result).toEqual({ ok: true, vector: true });
    await pool.end();
  });

  it("migrate creates document_chunks with vector(768)", async () => {
    const pool = createPool(url!);
    await migrate(pool);
    const { rows } = await pool.query(`
    SELECT column_name, udt_name
    FROM information_schema.columns
    WHERE table_name = 'document_chunks' AND column_name = 'embedding'
  `);
    expect(rows[0]?.udt_name).toBe("vector");
    await pool.end();
  });
});
