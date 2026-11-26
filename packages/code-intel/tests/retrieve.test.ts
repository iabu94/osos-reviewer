import {
  createPool,
  ensureDatabase,
  migrate,
  resolveTestDatabaseUrl,
} from "@osos-reviewer/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  lookupRelationships,
  lookupSymbols,
  replaceFileSymbols,
  type ParsedSymbol,
} from "../src/index.js";

const databaseUrl = resolveTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;

function sym(name: string, filePath: string, symbolType: ParsedSymbol["symbolType"] = "controller"): ParsedSymbol {
  return { symbolType, symbolName: name, filePath, lineStart: 1, lineEnd: 2, signature: `sig ${name}` };
}

describeWithDatabase("retrieve", () => {
  let pool: ReturnType<typeof createPool>;

  const put = (
    repo: string,
    scope: "baseline" | "pr",
    reviewId: string | null,
    filePath: string,
    symbols: ParsedSymbol[],
    relationships: Parameters<typeof replaceFileSymbols>[0]["relationships"] = [],
    commitSha = "sha-" + scope,
  ) =>
    replaceFileSymbols({
      pool,
      repo,
      indexScope: scope,
      reviewId,
      commitSha,
      branchTag: null,
      filePath,
      contentHash: "h",
      symbols,
      relationships,
    });

  beforeAll(async () => {
    await ensureDatabase(databaseUrl!);
    pool = createPool(databaseUrl!);
    await migrate(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE code_relationships, code_symbols RESTART IDENTITY CASCADE");
    await put("be", "baseline", null, "a.cs", [sym("OrdersController", "a.cs"), sym("BaselineOnly", "a.cs", "dto")]);
    await put("be", "pr", "rev-1", "a.cs", [sym("OrdersController", "a.cs"), sym("PrOnly", "a.cs", "dto")]);
    await put("fe", "baseline", null, "b.ts", [sym("OrderService", "b.ts", "angular_service")]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("nameContains is case-insensitive and respects indexScope", async () => {
    const prOnly = await lookupSymbols({ pool, nameContains: "orders", indexScope: "pr", reviewId: "rev-1" });
    expect(prOnly.map((s) => s.symbolName)).toEqual(["OrdersController"]);
    expect(prOnly.every((s) => s.indexScope === "pr" && s.reviewId === "rev-1")).toBe(true);
  });

  it("pr scope with reviewId never returns baseline-only hits", async () => {
    const hits = await lookupSymbols({ pool, indexScope: "pr", reviewId: "rev-1", nameContains: "BaselineOnly" });
    expect(hits).toEqual([]);
    const baseline = await lookupSymbols({ pool, indexScope: "baseline", nameContains: "PrOnly" });
    expect(baseline).toEqual([]);
  });

  it("pr scope without reviewId returns no rows from any review or baseline", async () => {
    expect(await lookupSymbols({ pool, indexScope: "pr" })).toEqual([]);
    expect(await lookupSymbols({ pool, indexScope: "pr", nameContains: "Orders" })).toEqual([]);
    expect(await lookupRelationships({ pool, indexScope: "pr" })).toEqual([]);
  });

  it("filters by repo, type, file path; returns mapped records", async () => {
    const [dto] = await lookupSymbols({ pool, repoIds: ["be"], symbolTypes: ["dto"], indexScope: "baseline" });
    expect(dto).toMatchObject({
      repo: "be",
      symbolName: "BaselineOnly",
      symbolType: "dto",
      filePath: "a.cs",
      indexScope: "baseline",
      reviewId: null,
      commitSha: "sha-baseline",
      lineStart: 1,
      lineEnd: 2,
      signature: "sig BaselineOnly",
      metadata: {},
    });
    expect(typeof dto.id).toBe("number");
    const fe = await lookupSymbols({ pool, repoIds: ["fe"] });
    expect(fe.map((s) => s.symbolName)).toEqual(["OrderService"]);
    expect((await lookupSymbols({ pool, filePaths: ["b.ts"] })).length).toBe(1);
  });

  it("commitSha filter, empty filters return [], literal wildcard chars", async () => {
    expect((await lookupSymbols({ pool, commitSha: "sha-pr" })).length).toBe(2);
    expect(await lookupSymbols({ pool, repoIds: [] })).toEqual([]);
    expect(await lookupSymbols({ pool, symbolTypes: [] })).toEqual([]);
    expect(await lookupSymbols({ pool, filePaths: [] })).toEqual([]);
    expect(await lookupSymbols({ pool, nameContains: "%" })).toEqual([]);
    expect(await lookupSymbols({ pool, nameContains: "zzz" })).toEqual([]);
  });

  it("limit defaults to 50 and caps at 200", async () => {
    const many = Array.from({ length: 260 }, (_, i) => sym(`Bulk${i}`, "bulk.cs", "dto"));
    await put("be", "baseline", null, "bulk.cs", many);
    expect((await lookupSymbols({ pool, nameContains: "bulk" })).length).toBe(50);
    expect((await lookupSymbols({ pool, nameContains: "bulk", limit: 10 })).length).toBe(10);
    expect((await lookupSymbols({ pool, nameContains: "bulk", limit: 5000 })).length).toBe(200);
  });

  it("lookupRelationships filters by source, type, scope and review", async () => {
    await put(
      "be",
      "pr",
      "rev-1",
      "c.cs",
      [sym("Svc", "c.cs", "service_method"), sym("Dto", "c.cs", "dto")],
      [
        { sourceName: "Svc", sourceType: "service_method", targetName: "Dto", relationshipType: "references", filePath: "c.cs", lineStart: 3 },
        { sourceName: "Svc", sourceType: "service_method", targetName: "Ext", relationshipType: "calls", filePath: "c.cs", lineStart: 4 },
      ],
    );
    await put(
      "be",
      "baseline",
      null,
      "c.cs",
      [sym("Svc", "c.cs", "service_method")],
      [{ sourceName: "Svc", sourceType: "service_method", targetName: "BaseTarget", relationshipType: "calls", filePath: "c.cs", lineStart: 9 }],
    );

    const [svc] = await lookupSymbols({ pool, indexScope: "pr", reviewId: "rev-1", nameContains: "Svc" });
    const all = await lookupRelationships({ pool, sourceSymbolId: svc.id, indexScope: "pr", reviewId: "rev-1" });
    expect(all.map((r) => r.targetName).sort()).toEqual(["Dto", "Ext"]);
    expect(all[0]).toMatchObject({ repo: "be", indexScope: "pr", reviewId: "rev-1", commitSha: "sha-pr", filePath: "c.cs" });

    const calls = await lookupRelationships({ pool, indexScope: "pr", reviewId: "rev-1", relationshipTypes: ["calls"] });
    expect(calls.map((r) => r.targetName)).toEqual(["Ext"]);

    const base = await lookupRelationships({ pool, indexScope: "baseline", repoIds: ["be"] });
    expect(base.map((r) => r.targetName)).toEqual(["BaseTarget"]);
    expect(base.every((r) => r.reviewId === null)).toBe(true);

    expect(await lookupRelationships({ pool, repoIds: [] })).toEqual([]);
    expect(await lookupRelationships({ pool, relationshipTypes: [] })).toEqual([]);
    expect(await lookupRelationships({ pool, indexScope: "pr", reviewId: "nope" })).toEqual([]);
    expect((await lookupRelationships({ pool, limit: 1 })).length).toBe(1);
  });
});
