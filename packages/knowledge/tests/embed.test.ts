import { describe, expect, it } from "vitest";

import { createEmbeddingProvider } from "../src/index.js";

describe("createEmbeddingProvider", () => {
  it("fake embedder is deterministic and 768-d", async () => {
    const p = createEmbeddingProvider({
      provider: "fake",
      model: "fake",
      dimensions: 768,
    });
    const [a] = await p.embed(["Prefer OnPush change detection"]);
    const [b] = await p.embed(["Prefer OnPush change detection"]);
    expect(a).toHaveLength(768);
    expect(a).toEqual(b);
  });

  it("gives texts with shared tokens a positive cosine similarity", async () => {
    const p = createEmbeddingProvider({
      provider: "fake",
      model: "fake",
      dimensions: 768,
    });
    const [a, b] = await p.embed([
      "Prefer OnPush change detection",
      "OnPush improves change detection",
    ]);
    const similarity = a.reduce(
      (sum, value, index) => sum + value * b[index],
      0,
    );

    expect(similarity).toBeGreaterThan(0);
  });
});
