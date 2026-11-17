import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Pool } from "pg";

import { chunkMarkdown } from "./chunk.js";
import { discoverDocuments } from "./discover.js";
import {
  EmbeddingError,
  type EmbeddingProvider,
} from "./embed.js";
import {
  deleteChunksForMissingPaths,
  deleteChunksNotIn,
  hasOnlyContentHash,
  upsertChunks,
  type StoredChunk,
} from "./store.js";

const EMBEDDING_BATCH_SIZE = 64;

export interface IngestReport {
  documentsSeen: number;
  chunksUpserted: number;
  chunksDeleted: number;
  documentsSkippedUnchanged: number;
}

async function embedChunks(
  embedder: EmbeddingProvider,
  texts: string[],
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const batchEmbeddings = await embedder.embed(batch);
    if (batchEmbeddings.length !== batch.length) {
      throw new EmbeddingError(
        `Embedding provider returned ${batchEmbeddings.length} vectors for ${batch.length} inputs`,
      );
    }
    embeddings.push(...batchEmbeddings);
  }
  return embeddings;
}

export async function ingestKnowledgeBase(opts: {
  rootDir: string;
  pool: Pool;
  embedder: EmbeddingProvider;
}): Promise<IngestReport> {
  const documents = await discoverDocuments(opts.rootDir);
  const report: IngestReport = {
    documentsSeen: documents.length,
    chunksUpserted: 0,
    chunksDeleted: 0,
    documentsSkippedUnchanged: 0,
  };

  for (const document of documents) {
    const fileBytes = await readFile(document.absolutePath);
    const contentHash = createHash("sha256").update(fileBytes).digest("hex");
    if (
      await hasOnlyContentHash(
        opts.pool,
        document.relativePath,
        contentHash,
      )
    ) {
      report.documentsSkippedUnchanged += 1;
      continue;
    }

    const drafts = chunkMarkdown(fileBytes.toString("utf8"), document);
    const embeddings = await embedChunks(
      opts.embedder,
      drafts.map((draft) => draft.chunkText),
    );
    const chunks: StoredChunk[] = drafts.map((draft, index) => ({
      ...draft,
      contentHash,
      embedding: embeddings[index],
    }));

    const client = await opts.pool.connect();
    try {
      await client.query("BEGIN");
      report.chunksUpserted += await upsertChunks(client, chunks);
      report.chunksDeleted += await deleteChunksNotIn(
        client,
        document.relativePath,
        chunks.map((chunk) => chunk.chunkHash),
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const client = await opts.pool.connect();
  try {
    await client.query("BEGIN");
    report.chunksDeleted += await deleteChunksForMissingPaths(
      client,
      documents.map((document) => document.relativePath),
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return report;
}
