import { fileURLToPath } from "node:url";

import {
  createPool,
  ensureDatabase,
  migrate,
  resolveTestDatabaseUrl,
} from "@osos-reviewer/db";
import {
  FakeEmbeddingProvider,
  ingestKnowledgeBase,
  type EmbeddingProvider,
} from "@osos-reviewer/knowledge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Pool } from "pg";

import { handleGetCodingStandards } from "../src/tools/get_coding_standards.js";
import { handleToolRouted } from "../src/tools/router.js";

const databaseUrl = resolveTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const knowledgeBaseRoot = fileURLToPath(
  new URL("../../../knowledge-base", import.meta.url),
);

describeWithDatabase("get_coding_standards", () => {
  let pool: ReturnType<typeof createPool>;
  const embedder = new FakeEmbeddingProvider();
  let deps: { pool: typeof pool; embedder: typeof embedder };
  const explodingEmbedder: EmbeddingProvider = {
    dimensions: 768,
    modelId: "fake:exploding",
    async embed() {
      throw new Error("embedder offline");
    },
  };

  beforeAll(async () => {
    await ensureDatabase(databaseUrl!);
    pool = createPool(databaseUrl!);
    deps = { pool, embedder };
    await migrate(pool);
    await pool.query("TRUNCATE document_chunks");
    await ingestKnowledgeBase({ rootDir: knowledgeBaseRoot, pool, embedder });
  });

  afterAll(async () => {
    await pool.query("TRUNCATE document_chunks");
    await pool.end();
  });

  it("get_coding_standards returns ok rules after fake ingest", async () => {
    const result = await handleGetCodingStandards(
      {
        query: "Prefer OnPush change detection",
        technology: "angular",
        limit: 3,
      },
      deps,
    );
    expect(result.status).toBe("ok");
    const rules = (result.data as { rules: Array<Record<string, any>> }).rules;
    expect(rules[0].documentPath).toMatch(/components\.md$/);
    expect(rules[0].section.length).toBeGreaterThan(0);
    expect(JSON.stringify(result).length).toBeLessThan(12_000);
  });

  it("bounds the payload at the maximum limit", async () => {
    const result = await handleGetCodingStandards(
      { query: "standards", limit: 10 },
      deps,
    );
    expect(JSON.stringify(result).length).toBeLessThan(12_000);
  });

  it("returns invalid_args for missing query or bad enum", async () => {
    for (const args of [{}, { query: "" }, { query: "x", technology: "cobol" }]) {
      const result = await handleGetCodingStandards(args, deps);
      expect(result.status).toBe("service_error");
      expect(result.error?.code).toBe("invalid_args");
    }
  });

  it("get_coding_standards returns service_error when embedder throws", async () => {
    const result = await handleGetCodingStandards(
      { query: "x" },
      { pool, embedder: explodingEmbedder },
    );
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("retrieval_failed");
  });

  const routerOptions = () => ({
    getStandardsDeps: async () => deps,
    getCodeIntelDeps: async () => deps,
  });

  it("router sends get_coding_standards to the real handler", async () => {
    const result = await handleToolRouted(
      "get_coding_standards",
      { query: "Prefer OnPush change detection", technology: "angular" },
      routerOptions(),
    );
    expect(result.status).toBe("ok");

    const reuse = await handleToolRouted(
      "check_reusability",
      { query: "OnPush" },
      routerOptions(),
    );
    expect(["ok", "no_results"]).toContain(reuse.status);

    const unknown = await handleToolRouted("nope", {}, routerOptions());
    expect(unknown.error?.code).toBe("unknown_tool");
  });

  it("router returns retrieval_failed when deps cannot load", async () => {
    const result = await handleToolRouted(
      "get_coding_standards",
      { query: "x" },
      {
        getStandardsDeps: async () => {
          throw new Error("bad config");
        },
        getCodeIntelDeps: async () => {
          throw new Error("bad config");
        },
      },
    );
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("retrieval_failed");
  });

  it("router returns invalid_args before initializing deps", async () => {
    let initialized = false;
    const options = {
      getStandardsDeps: async () => {
        initialized = true;
        throw new Error("broken db config");
      },
      getCodeIntelDeps: async () => {
        initialized = true;
        throw new Error("broken db config");
      },
    };
    for (const args of [{}, { query: "" }, { query: "x", limit: 99 }]) {
      const result = await handleToolRouted("get_coding_standards", args, options);
      expect(result.status).toBe("service_error");
      expect(result.error?.code).toBe("invalid_args");
    }
    expect(initialized).toBe(false);
  });

  it("keeps payload under 12000 chars for oversized rules and metadata", async () => {
    const huge = (n: number) => "\"\\é".repeat(n);
    const fakePool = {
      query: async () => ({
        rows: Array.from({ length: 10 }, (_, i) => ({
          source_path: `a/${i}/${huge(5000)}.md`,
          document_title: huge(5000),
          section: huge(5000),
          category: "coding-standards",
          technology: "angular",
          chunk_text: huge(50_000),
          distance: 0.1,
        })),
      }),
    } as unknown as Pool;
    for (const limit of [1, 10]) {
      const result = await handleGetCodingStandards(
        { query: "x", limit },
        { pool: fakePool, embedder },
      );
      expect(result.status).toBe("ok");
      expect(JSON.stringify(result).length).toBeLessThan(12_000);
    }
  });

  // Keep last: empties the index.
  it("get_coding_standards returns no_results for empty index", async () => {
    await pool.query("TRUNCATE document_chunks");
    const result = await handleGetCodingStandards({ query: "anything" }, deps);
    expect(result.status).toBe("no_results");
    expect(result.data).toEqual({ rules: [] });
  });
});
