import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPool,
  ensureDatabase,
  migrate,
  resolveTestDatabaseUrl,
} from "@review/db";
import { FakeEmbeddingProvider } from "@review/knowledge";
import type { RepoConfig } from "@review/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  indexBaseline,
  replaceFileSymbols,
  traceSymbolImpact,
  type ParsedSymbol,
} from "../src/index.js";

const databaseUrl = resolveTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDotnetRoot = join(here, "..", "fixtures", "dotnet");

describeWithDatabase("traceSymbolImpact", () => {
  let pool: ReturnType<typeof createPool>;
  const embedder = new FakeEmbeddingProvider();

  beforeAll(async () => {
    await ensureDatabase(databaseUrl!);
    pool = createPool(databaseUrl!);
    await migrate(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE code_relationships, code_symbols RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  async function baseline(repo: RepoConfig, rootDir: string): Promise<void> {
    await indexBaseline({
      pool,
      repo,
      commitSha: "base-sha",
      branchTag: "develop",
      rootDir,
      embedder,
    });
  }

  it("returns seed and relationship targets for OrdersController", async () => {
    await baseline(
      { id: "be", role: "backend", localPath: fixtureDotnetRoot, defaultBaseBranch: "develop" },
      fixtureDotnetRoot,
    );
    const impacted = await traceSymbolImpact({
      pool,
      symbolName: "OrdersController",
      repoIds: ["be"],
      maxDepth: 2,
    });
    expect(impacted[0]?.via).toBe("seed");
    expect(impacted.some((i) => i.symbolName.includes("Orders") || i.filePath.includes("Orders"))).toBe(true);
  });

  it("returns empty array for unknown symbol", async () => {
    expect(await traceSymbolImpact({ pool, symbolName: "DoesNotExist_ZZZ" })).toEqual([]);
  });

  it("prefers PR-indexed seed over baseline when reviewId is set", async () => {
    const filePath = "OrdersController.cs";
    const seedName = "OrdersController";
    const baseSeed: ParsedSymbol = {
      symbolType: "controller",
      symbolName: seedName,
      filePath,
      lineStart: 1,
      lineEnd: 40,
      signature: "baseline OrdersController",
    };
    const prTarget: ParsedSymbol = {
      symbolType: "service_method",
      symbolName: "PrImpactTarget",
      filePath: "PrOnly.cs",
      lineStart: 1,
      lineEnd: 5,
      signature: "void OnlyInPr()",
    };
    await replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: "baseline",
      reviewId: null,
      commitSha: "base-sha",
      branchTag: null,
      filePath,
      contentHash: "h-base",
      symbols: [baseSeed],
      relationships: [],
    });
    await replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: "pr",
      reviewId: "rev-impact",
      commitSha: "pr-sha",
      branchTag: null,
      filePath,
      contentHash: "h-pr",
      symbols: [
        { ...baseSeed, signature: "pr OrdersController" },
        prTarget,
      ],
      relationships: [
        {
          sourceName: seedName,
          sourceType: "controller",
          targetName: "PrImpactTarget",
          relationshipType: "calls",
          filePath,
          lineStart: 10,
        },
      ],
    });
    const impacted = await traceSymbolImpact({
      pool,
      symbolName: seedName,
      repoIds: ["be"],
      reviewId: "rev-impact",
      maxDepth: 1,
    });
    const seed = impacted.find((i) => i.via === "seed");
    expect(seed).toMatchObject({ symbolName: seedName, signature: "pr OrdersController" });
    expect(impacted.some((i) => i.symbolName === "PrImpactTarget")).toBe(true);
  });

  it("does not traverse past maxDepth 0", async () => {
    await baseline(
      { id: "be", role: "backend", localPath: fixtureDotnetRoot, defaultBaseBranch: "develop" },
      fixtureDotnetRoot,
    );
    const impacted = await traceSymbolImpact({
      pool,
      symbolName: "OrdersController",
      repoIds: ["be"],
      maxDepth: 0,
    });
    expect(impacted.length).toBeGreaterThanOrEqual(1);
    expect(impacted.every((i) => i.depth === 0 && i.via === "seed")).toBe(true);
  });
});