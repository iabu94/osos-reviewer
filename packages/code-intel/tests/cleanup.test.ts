import {
  createPool,
  ensureDatabase,
  migrate,
  resolveTestDatabaseUrl,
} from "@osos-reviewer/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupPrIndex,
  lookupSymbols,
  replaceFileSymbols,
  type ParsedSymbol,
} from "../src/index.js";

const databaseUrl = resolveTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const sym = (name: string): ParsedSymbol => ({
  symbolType: "controller",
  symbolName: name,
  filePath: "a.cs",
  lineStart: 1,
  lineEnd: 2,
  signature: name,
});

describeWithDatabase("cleanupPrIndex", () => {
  let pool: ReturnType<typeof createPool>;

  const put = (scope: "baseline" | "pr", reviewId: string | null, name: string) =>
    replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: scope,
      reviewId,
      commitSha: "sha",
      branchTag: null,
      filePath: `${name}.cs`,
      contentHash: "h",
      symbols: [sym(name)],
      relationships: [
        { sourceName: name, sourceType: "controller", targetName: "T", relationshipType: "calls", filePath: `${name}.cs`, lineStart: 1 },
      ],
    });

  beforeAll(async () => {
    await ensureDatabase(databaseUrl!);
    pool = createPool(databaseUrl!);
    await migrate(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE code_relationships, code_symbols RESTART IDENTITY CASCADE");
    await put("baseline", null, "Base");
    await put("pr", "rev-1", "Pr1");
    await put("pr", "rev-2", "Pr2");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("deletes pr rows for the review only, cascading relationships", async () => {
    const result = await cleanupPrIndex(pool, "rev-1");
    expect(result).toEqual({ symbolsDeleted: 1 });
    expect(await lookupSymbols({ pool, reviewId: "rev-1" })).toEqual([]);
    expect((await lookupSymbols({ pool, indexScope: "baseline", repoIds: ["be"] })).length).toBe(1);
    expect((await lookupSymbols({ pool, reviewId: "rev-2" })).length).toBe(1);
    const rels = await pool.query("SELECT index_scope, review_id FROM code_relationships ORDER BY id");
    expect(rels.rows).toEqual([
      { index_scope: "baseline", review_id: null },
      { index_scope: "pr", review_id: "rev-2" },
    ]);
  });

  it("is idempotent", async () => {
    await cleanupPrIndex(pool, "rev-1");
    expect(await cleanupPrIndex(pool, "rev-1")).toEqual({ symbolsDeleted: 0 });
  });
});
