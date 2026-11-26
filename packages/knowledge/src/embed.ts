import { createHash } from "node:crypto";

import type { EmbeddingConfig } from "@osos-reviewer/shared";

const EMBEDDING_DIMENSIONS = 768 as const;

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimensions: 768;
  /** Stable `provider:model` id stored with each vector. */
  readonly modelId: string;
}

export class EmbeddingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddingError";
  }
}

export const FAKE_EMBEDDING_MODEL_ID = "fake:token-hash-768";

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly modelId = FAKE_EMBEDDING_MODEL_ID;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = Array<number>(this.dimensions).fill(0);
      const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
      for (const token of tokens) {
        const digest = createHash("sha256").update(token).digest();
        const index = digest.readUInt32BE(0) % this.dimensions;
        vector[index] += 1;
      }

      const magnitude = Math.sqrt(
        vector.reduce((sum, value) => sum + value * value, 0),
      );
      return magnitude === 0
        ? vector
        : vector.map((value) => value / magnitude);
    });
  }
}

export class OpenAICompatibleEmbeddingProvider
  implements EmbeddingProvider
{
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly modelId: string;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.modelId = `openai_compatible:${model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          dimensions: this.dimensions,
        }),
      });
    } catch (error) {
      throw new EmbeddingError("Embedding request failed", { cause: error });
    }

    if (!response.ok) {
      throw new EmbeddingError(
        `Embedding request failed with status ${response.status}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new EmbeddingError("Embedding response was not valid JSON", {
        cause: error,
      });
    }

    const data =
      typeof payload === "object" && payload !== null && "data" in payload
        ? payload.data
        : undefined;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new EmbeddingError(
        `Embedding response returned ${Array.isArray(data) ? data.length : 0} vectors for ${texts.length} inputs`,
      );
    }

    return data.map((item, index) => {
      const embedding =
        typeof item === "object" && item !== null && "embedding" in item
          ? item.embedding
          : undefined;
      if (
        !Array.isArray(embedding) ||
        embedding.length !== this.dimensions ||
        !embedding.every((value) => typeof value === "number")
      ) {
        throw new EmbeddingError(
          `Embedding vector ${index} must contain exactly ${this.dimensions} numbers`,
        );
      }
      return embedding as number[];
    });
  }
}

export function createEmbeddingProvider(
  config: EmbeddingConfig,
): EmbeddingProvider {
  if (config.provider === "fake") {
    return new FakeEmbeddingProvider();
  }
  if (!config.baseUrl) {
    throw new EmbeddingError(
      "baseUrl is required for the openai_compatible provider",
    );
  }
  if (!config.apiKey) {
    throw new EmbeddingError(
      "apiKey is required for the openai_compatible provider",
    );
  }
  return new OpenAICompatibleEmbeddingProvider(
    config.baseUrl,
    config.apiKey,
    config.model,
  );
}
