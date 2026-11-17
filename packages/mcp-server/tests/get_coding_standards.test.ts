import { fileURLToPath } from "node:url";

import { createPool, migrate } from "@review/db";
import {
  FakeEmbeddingProvider,
  ingestKnowledgeBase,
  type EmbeddingProvider,
} from "@review/knowledge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleGetCodingStandards } from "../src/tools/get_coding_standards.js";
import { handleToolRouted } from "../src/tools/router.js";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const knowledgeBaseRoot = fileURLToPath(
  new URL("../../../knowledge-base", import.meta.url),
);

describeWithDatabase("get_coding_standards", () => {
  const pool = createPool(databaseUrl!);
  const embedder = new FakeEmbeddingProvider();
  const deps = { pool, embedder };
  const explodingEmbedder: EmbeddingProvider = {
    dimensions: 768,
    async embed() {
      throw new Error("embedder offline");
    },
  };

  beforeAll(async () => {
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

  it("router sends get_coding_standards to the real handler", async () => {
    const result = await handleToolRouted(
      "get_coding_standards",
      { query: "Prefer OnPush change detection", technology: "angular" },
      { getStandardsDeps: async () => deps },
    );
    expect(result.status).toBe("ok");

    const stub = await handleToolRouted("check_reusability", {}, {
      getStandardsDeps: async () => deps,
    });
    expect(stub.status).toBe("no_results");

    const unknown = await handleToolRouted("nope", {}, {
      getStandardsDeps: async () => deps,
    });
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
      },
    );
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("retrieval_failed");
  });

  // Keep last: empties the index.
  it("get_coding_standards returns no_results for empty index", async () => {
    await pool.query("TRUNCATE document_chunks");
    const result = await handleGetCodingStandards({ query: "anything" }, deps);
    expect(result.status).toBe("no_results");
    expect(result.data).toEqual({ rules: [] });
  });
});
