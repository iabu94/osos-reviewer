import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEmbeddingProvider,
  EmbeddingError,
} from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("exposes stable provider:model ids", () => {
    const fake = createEmbeddingProvider({
      provider: "fake",
      model: "ignored",
      dimensions: 768,
    });
    expect(fake.modelId).toBe("fake:token-hash-768");
    const remote = createEmbeddingProvider({
      provider: "openai_compatible",
      baseUrl: "https://embeddings.example.test",
      apiKey: "k",
      model: "text-embedding-3-small",
      dimensions: 768,
    });
    expect(remote.modelId).toBe("openai_compatible:text-embedding-3-small");
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

  it("throws EmbeddingError for malformed data entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [null] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const p = createEmbeddingProvider({
      provider: "openai_compatible",
      baseUrl: "https://embeddings.example.test",
      apiKey: "test-key",
      model: "test-model",
      dimensions: 768,
    });

    await expect(p.embed(["text"])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it("throws EmbeddingError for non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    const p = createEmbeddingProvider({
      provider: "openai_compatible",
      baseUrl: "https://embeddings.example.test",
      apiKey: "test-key",
      model: "test-model",
      dimensions: 768,
    });

    await expect(p.embed(["text"])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it("throws EmbeddingError when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unavailable")),
    );
    const p = createEmbeddingProvider({
      provider: "openai_compatible",
      baseUrl: "https://embeddings.example.test",
      apiKey: "test-key",
      model: "test-model",
      dimensions: 768,
    });

    await expect(p.embed(["text"])).rejects.toBeInstanceOf(EmbeddingError);
  });
});
