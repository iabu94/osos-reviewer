import type { EmbeddingProvider } from "@osos-reviewer/knowledge";

import type { ParsedSymbol } from "./types.js";

const EMBEDDING_BATCH_SIZE = 64;

export function symbolEmbeddingText(symbol: ParsedSymbol): string {
  return `${symbol.signature}\n${symbol.summary ?? ""}`;
}

/** One vector per symbol, in symbol order, embedded in provider-sized batches. */
export async function embedSymbols(
  embedder: EmbeddingProvider,
  symbols: ParsedSymbol[],
): Promise<number[][]> {
  const texts = symbols.map(symbolEmbeddingText);
  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const result = await embedder.embed(batch);
    if (result.length !== batch.length) {
      throw new Error(
        `Embedding provider returned ${result.length} vectors for ${batch.length} inputs`,
      );
    }
    vectors.push(...result);
  }
  return vectors;
}
