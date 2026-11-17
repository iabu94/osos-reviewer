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

import { handleTraceFeBeIntegration } from "../src/tools/trace_fe_be_integration.js";
import { handleToolRouted } from "../src/tools/router.js";

const databaseUrl = resolveTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const mismatchBackend = join(here, "../../code-intel/fixtures/mismatch/backend");
const mismatchFrontend = join(here, "../../code-intel/fixtures/mismatch/frontend");

describeWithDatabase("trace_fe_be_integration", () => {
  let pool: ReturnType<typeof createPool>;
  const embedder = new FakeEmbeddingProvider();
  const deps = () => ({ pool });

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

  it("trace_fe_be_integration returns ok mismatches for mismatch fixtures", async () => {
    await baseline(
      { id: "be-bad", role: "backend", localPath: mismatchBackend, defaultBaseBranch: "develop" },
      mismatchBackend,
    );
    await baseline(
      { id: "fe-bad", role: "frontend", localPath: mismatchFrontend, defaultBaseBranch: "develop" },
      mismatchFrontend,
    );
    const result = await handleTraceFeBeIntegration(
      { backendRepoIds: ["be-bad"], frontendRepoIds: ["fe-bad"] },
      deps(),
    );
    expect(result.status).toBe("ok");
    const mismatches = (result.data as { mismatches: unknown[] }).mismatches;
    expect(mismatches.length).toBeGreaterThan(0);
    expect(JSON.stringify(result).length).toBeLessThan(12_000);
  });

  it("returns invalid_args when repo id arrays are empty", async () => {
    const result = await handleTraceFeBeIntegration(
      { backendRepoIds: [], frontendRepoIds: ["fe"] },
      deps(),
    );
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("invalid_args");
  });

  it("router routes to the live handler", async () => {
    await baseline(
      { id: "be-bad", role: "backend", localPath: mismatchBackend, defaultBaseBranch: "develop" },
      mismatchBackend,
    );
    await baseline(
      { id: "fe-bad", role: "frontend", localPath: mismatchFrontend, defaultBaseBranch: "develop" },
      mismatchFrontend,
    );
    const options = {
      getStandardsDeps: async () => ({ pool, embedder }),
      getCodeIntelDeps: async () => ({ pool, embedder }),
    };
    const result = await handleToolRouted(
      "trace_fe_be_integration",
      { backendRepoIds: ["be-bad"], frontendRepoIds: ["fe-bad"] },
      options,
    );
    expect(result.status).toBe("ok");
  });
});