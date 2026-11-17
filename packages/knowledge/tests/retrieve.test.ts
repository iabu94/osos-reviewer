import { fileURLToPath } from "node:url";

import { createPool, migrate } from "@review/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FakeEmbeddingProvider,
  ingestKnowledgeBase,
  retrieveCodingStandards,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const knowledgeBaseRoot = fileURLToPath(
  new URL("../../../knowledge-base", import.meta.url),
);

describeWithDatabase("retrieveCodingStandards", () => {
  const pool = createPool(databaseUrl!);
  const embedder = new FakeEmbeddingProvider();

  beforeAll(async () => {
    await migrate(pool);
    await pool.query("TRUNCATE document_chunks");
    await ingestKnowledgeBase({
      rootDir: knowledgeBaseRoot,
      pool,
      embedder,
    });
  });

  afterAll(async () => {
    await pool.query("TRUNCATE document_chunks");
    await pool.end();
  });

  it("returns Angular OnPush rule for an Angular query and excludes it when technology=dotnet", async () => {
    const angularHits = await retrieveCodingStandards({
      pool,
      embedder,
      query: "Angular component change detection OnPush",
      category: "coding-standards",
      technology: "angular",
      limit: 5,
    });
    expect(angularHits.some((r) => /OnPush/i.test(r.ruleText))).toBe(true);
    expect(angularHits.every((r) => r.technology === "angular")).toBe(true);

    const dotnetOnly = await retrieveCodingStandards({
      pool,
      embedder,
      query: "Angular component change detection OnPush",
      technology: "dotnet",
      limit: 5,
    });
    expect(dotnetOnly.every((r) => r.technology === "dotnet")).toBe(true);
    expect(dotnetOnly.some((r) => /OnPush/i.test(r.ruleText))).toBe(false);
  });

  it("returns empty array when index has no rows", async () => {
    await pool.query("TRUNCATE document_chunks");

    const hits = await retrieveCodingStandards({
      pool,
      embedder,
      query: "anything",
    });
    expect(hits).toEqual([]);
  });
});
