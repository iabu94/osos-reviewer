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
  normalizeRoutePath,
  traceFeBeIntegration,
} from "../src/index.js";

const databaseUrl = resolveTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDotnetRoot = join(here, "..", "fixtures", "dotnet");
const fixtureAngularRoot = join(here, "..", "fixtures", "angular");
const mismatchBackend = join(here, "..", "fixtures", "mismatch", "backend");
const mismatchFrontend = join(here, "..", "fixtures", "mismatch", "frontend");

describeWithDatabase("traceFeBeIntegration", () => {
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

  it("detects missing backend for deliberate FE path mismatch", async () => {
    await baseline(
      { id: "be-bad", role: "backend", localPath: mismatchBackend, defaultBaseBranch: "develop" },
      mismatchBackend,
    );
    await baseline(
      { id: "fe-bad", role: "frontend", localPath: mismatchFrontend, defaultBaseBranch: "develop" },
      mismatchFrontend,
    );
    const mismatches = await traceFeBeIntegration({
      pool,
      backendRepoIds: ["be-bad"],
      frontendRepoIds: ["fe-bad"],
    });
    expect(mismatches.some((m) => m.kind === "missing_backend")).toBe(true);
    expect(
      mismatches.some(
        (m) =>
          m.kind === "missing_backend" &&
          normalizeRoutePath(String(m.detail?.path ?? "")).includes("api/order"),
      ),
    ).toBe(true);
  });

  it("flags OrderDto shape drift on matching GET api/orders", async () => {
    await baseline(
      { id: "be", role: "backend", localPath: fixtureDotnetRoot, defaultBaseBranch: "develop" },
      fixtureDotnetRoot,
    );
    await baseline(
      { id: "fe", role: "frontend", localPath: fixtureAngularRoot, defaultBaseBranch: "develop" },
      fixtureAngularRoot,
    );
    const mismatches = await traceFeBeIntegration({
      pool,
      backendRepoIds: ["be"],
      frontendRepoIds: ["fe"],
    });
    expect(mismatches.some((m) => m.kind === "shape_mismatch")).toBe(true);
  });
});