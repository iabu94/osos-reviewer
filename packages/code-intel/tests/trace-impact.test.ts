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

import { indexBaseline, traceSymbolImpact } from "../src/index.js";

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
});