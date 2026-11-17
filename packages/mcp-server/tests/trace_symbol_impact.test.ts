import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { indexBaseline } from "@review/code-intel";
import {
  createPool,
  ensureDatabase,
  migrate,
  resolveTestDatabaseUrl,
} from "@review/db";
import { FakeEmbeddingProvider } from "@review/knowledge";
import type { RepoConfig } from "@review/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { handleTraceSymbolImpact } from "../src/tools/trace_symbol_impact.js";

const databaseUrl = resolveTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDotnetRoot = join(here, "../../code-intel/fixtures/dotnet");

describeWithDatabase("trace_symbol_impact", () => {
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

  it("trace_symbol_impact returns no_results for unknown symbol", async () => {
    await baseline(
      { id: "be", role: "backend", localPath: fixtureDotnetRoot, defaultBaseBranch: "develop" },
      fixtureDotnetRoot,
    );
    const result = await handleTraceSymbolImpact(
      { symbolName: "Nope_ZZZ" },
      { pool },
    );
    expect(result.status).toBe("no_results");
    expect(result.data).toEqual({ impacted: [] });
  });

  it("returns ok with impacted symbols for a known seed", async () => {
    await baseline(
      { id: "be", role: "backend", localPath: fixtureDotnetRoot, defaultBaseBranch: "develop" },
      fixtureDotnetRoot,
    );
    const result = await handleTraceSymbolImpact(
      { symbolName: "OrdersController", repoIds: ["be"], maxDepth: 2 },
      { pool },
    );
    expect(result.status).toBe("ok");
    const impacted = (result.data as { impacted: unknown[] }).impacted;
    expect(impacted.length).toBeGreaterThan(0);
    expect(JSON.stringify(result).length).toBeLessThan(12_000);
  });
});