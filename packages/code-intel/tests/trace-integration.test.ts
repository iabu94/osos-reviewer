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
  replaceFileSymbols,
  traceFeBeIntegration,
  type ParsedSymbol,
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
    const shape = mismatches.find((m) => m.kind === "shape_mismatch");
    expect(shape).toBeDefined();
    expect(shape!.frontend).toMatchObject({ symbolType: "interface", symbolName: "OrderDto" });
    expect(shape!.backend).toMatchObject({ symbolType: "dto", symbolName: "OrderDto" });
  });

  it("prefers PR-indexed endpoint over baseline when reviewId is set", async () => {
    const beFile = "OrdersController.cs";
    const endpointName = "OrdersController.List";
    const listSig = "public async Task<ActionResult<IReadOnlyList<OrderDto>>> List()";
    const baseEndpoint: ParsedSymbol = {
      symbolType: "endpoint",
      symbolName: endpointName,
      filePath: beFile,
      lineStart: 16,
      lineEnd: 20,
      signature: listSig,
      metadata: { httpMethod: "GET", route: "api/orders" },
    };
    await replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: "baseline",
      reviewId: null,
      commitSha: "base-sha",
      branchTag: "develop",
      filePath: beFile,
      contentHash: "h-base",
      symbols: [baseEndpoint],
      relationships: [],
    });
    await replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: "pr",
      reviewId: "rev-merge",
      commitSha: "pr-sha",
      branchTag: "feature/x",
      filePath: beFile,
      contentHash: "h-pr",
      symbols: [
        {
          ...baseEndpoint,
          metadata: { httpMethod: "GET", route: "api/v2/orders" },
        },
      ],
      relationships: [],
    });
    const feCall: ParsedSymbol = {
      symbolType: "http_call",
      symbolName: "GET /api/v2/orders",
      filePath: "order.service.ts",
      lineStart: 10,
      lineEnd: 10,
      signature: "this.http.get<OrderDto[]>('/api/v2/orders')",
      metadata: { httpMethod: "GET", path: "/api/v2/orders", caller: "OrderService.list" },
    };
    await replaceFileSymbols({
      pool,
      repo: "fe",
      indexScope: "baseline",
      reviewId: null,
      commitSha: "base-sha",
      branchTag: "develop",
      filePath: "order.service.ts",
      contentHash: "h-fe",
      symbols: [feCall],
      relationships: [],
    });
    await replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: "baseline",
      reviewId: null,
      commitSha: "base-sha",
      branchTag: "develop",
      filePath: "OrderDto.cs",
      contentHash: "dto-be",
      symbols: [
        {
          symbolType: "dto",
          symbolName: "OrderDto",
          filePath: "OrderDto.cs",
          lineStart: 1,
          lineEnd: 1,
          signature: "record OrderDto",
          metadata: { properties: ["Id", "CustomerId", "Total"] },
        },
      ],
      relationships: [],
    });
    await replaceFileSymbols({
      pool,
      repo: "fe",
      indexScope: "baseline",
      reviewId: null,
      commitSha: "base-sha",
      branchTag: "develop",
      filePath: "order.model.ts",
      contentHash: "dto-fe",
      symbols: [
        {
          symbolType: "interface",
          symbolName: "OrderDto",
          filePath: "order.model.ts",
          lineStart: 1,
          lineEnd: 5,
          signature: "export interface OrderDto",
          metadata: { properties: ["id", "customerName", "total"] },
        },
      ],
      relationships: [],
    });

    const withPr = await traceFeBeIntegration({
      pool,
      backendRepoIds: ["be"],
      frontendRepoIds: ["fe"],
      reviewId: "rev-merge",
    });
    expect(withPr.some((m) => m.kind === "missing_backend")).toBe(false);
    expect(withPr.some((m) => m.kind === "shape_mismatch")).toBe(true);

    const baselineOnly = await traceFeBeIntegration({
      pool,
      backendRepoIds: ["be"],
      frontendRepoIds: ["fe"],
    });
    expect(baselineOnly.some((m) => m.kind === "missing_backend")).toBe(true);
  });

  it("reports method_mismatch when path matches but HTTP method does not", async () => {
    await replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: "baseline",
      reviewId: null,
      commitSha: "base-sha",
      branchTag: "develop",
      filePath: "WidgetsController.cs",
      contentHash: "be-w",
      symbols: [
        {
          symbolType: "endpoint",
          symbolName: "WidgetsController.Upsert",
          filePath: "WidgetsController.cs",
          lineStart: 5,
          lineEnd: 8,
          signature: "public Task Upsert()",
          metadata: { httpMethod: "PUT", route: "api/widgets" },
        },
      ],
      relationships: [],
    });
    await replaceFileSymbols({
      pool,
      repo: "fe",
      indexScope: "baseline",
      reviewId: null,
      commitSha: "base-sha",
      branchTag: "develop",
      filePath: "widgets.service.ts",
      contentHash: "fe-w",
      symbols: [
        {
          symbolType: "http_call",
          symbolName: "GET /api/widgets",
          filePath: "widgets.service.ts",
          lineStart: 4,
          lineEnd: 4,
          signature: "this.http.get<WidgetDto>('/api/widgets')",
          metadata: { httpMethod: "GET", path: "/api/widgets", caller: "WidgetService.load" },
        },
      ],
      relationships: [],
    });

    const mismatches = await traceFeBeIntegration({
      pool,
      backendRepoIds: ["be"],
      frontendRepoIds: ["fe"],
    });
    const method = mismatches.find((m) => m.kind === "method_mismatch");
    expect(method).toBeDefined();
    expect(normalizeRoutePath(String(method!.detail?.path ?? ""))).toBe("api/widgets");
  });

  it("emits missing_frontend when includeUnmatchedBackend is true", async () => {
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
      includeUnmatchedBackend: true,
    });
    expect(mismatches.some((m) => m.kind === "missing_frontend")).toBe(true);
    const missingFe = mismatches.find((m) => m.kind === "missing_frontend");
    expect(normalizeRoutePath(String(missingFe!.detail?.path ?? ""))).toBe("api/orders");
  });
});