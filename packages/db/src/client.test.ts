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
});
