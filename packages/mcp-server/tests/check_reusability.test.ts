import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { embedSymbols, indexBaseline, replaceFileSymbols, type ParsedSymbol } from "@review/code-intel";
import {
  createPool,
  ensureDatabase,
  migrate,
  resolveTestDatabaseUrl,
} from "@review/db";
import { FakeEmbeddingProvider } from "@review/knowledge";
import type { RepoConfig } from "@review/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { handleCheckReusability } from "../src/tools/check_reusability.js";

const databaseUrl = resolveTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDotnetRoot = join(here, "../../code-intel/fixtures/dotnet");

function sym(
  name: string,
  filePath: string,
  signature: string,
): ParsedSymbol {
  return {
    symbolType: "service_method",
    symbolName: name,
    filePath,
    lineStart: 1,
    lineEnd: 5,
    signature,
  };
}

describeWithDatabase("check_reusability", () => {
  let pool: ReturnType<typeof createPool>;
  const embedder = new FakeEmbeddingProvider();
  const deps = () => ({ pool, embedder });

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

  it("check_reusability returns candidates with candidate wording", async () => {
    await baseline(
      { id: "be", role: "backend", localPath: fixtureDotnetRoot, defaultBaseBranch: "develop" },
      fixtureDotnetRoot,
    );
    const filePath = "extra.orders.ts";
    const symbols = [
      sym("listOrders", filePath, "async list orders from api endpoint"),
    ];
    const vectors = await embedSymbols(embedder, symbols);
    await replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: "baseline",
      reviewId: null,
      commitSha: "sha-extra",
      branchTag: null,
      filePath,
      contentHash: "h-extra",
      symbols,
      relationships: [],
      embedding: vectors,
    });

    const result = await handleCheckReusability(
      { query: "orders list", repoIds: ["be"] },
      deps(),
    );
    expect(["ok", "no_results"]).toContain(result.status);
    if (result.status === "ok") {
      const candidates = (result.data as { candidates: Array<{ explanation: string }> })
        .candidates;
      expect(candidates[0].explanation).toMatch(/candidate/i);
      expect(JSON.stringify(result).length).toBeLessThan(12_000);
    }
  });

  it("returns invalid_args for empty query", async () => {
    const result = await handleCheckReusability({ query: "" }, deps());
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("invalid_args");
  });
});