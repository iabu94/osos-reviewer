import type { PoolClient } from "pg";

import type { DocumentChunkDraft } from "./chunk.js";

type Queryable = Pick<PoolClient, "query">;

export interface StoredChunk extends DocumentChunkDraft {
  contentHash: string;
  embedding: number[];
}

export async function hasOnlyContentHash(
  database: Queryable,
  sourcePath: string,
  contentHash: string,
): Promise<boolean> {
  const result = await database.query<{ content_hash: string }>(
    "SELECT content_hash FROM document_chunks WHERE source_path = $1",
    [sourcePath],
  );
  return (
    result.rows.length > 0 &&
    result.rows.every((row) => row.content_hash === contentHash)
  );
}

export async function upsertChunks(
  database: Queryable,
  chunks: StoredChunk[],
): Promise<number> {
  let upserted = 0;
  for (const chunk of chunks) {
    const result = await database.query(
      `INSERT INTO document_chunks (
         source_path, document_title, section, category, technology,
         chunk_text, content_hash, chunk_hash, embedding
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)
       ON CONFLICT (chunk_hash) DO UPDATE SET
         source_path = EXCLUDED.source_path,
         document_title = EXCLUDED.document_title,
         section = EXCLUDED.section,
         category = EXCLUDED.category,
         technology = EXCLUDED.technology,
         chunk_text = EXCLUDED.chunk_text,
         content_hash = EXCLUDED.content_hash,
         embedding = EXCLUDED.embedding,
         updated_at = now()`,
      [
        chunk.sourcePath,
        chunk.documentTitle,
        chunk.section,
        chunk.category,
        chunk.technology,
        chunk.chunkText,
        chunk.contentHash,
        chunk.chunkHash,
        `[${chunk.embedding.join(",")}]`,
      ],
    );
    upserted += result.rowCount ?? 0;
  }
  return upserted;
}

export async function deleteChunksNotIn(
  database: Queryable,
  sourcePath: string,
  chunkHashes: string[],
): Promise<number> {
  const result =
    chunkHashes.length === 0
      ? await database.query(
          "DELETE FROM document_chunks WHERE source_path = $1",
          [sourcePath],
        )
      : await database.query(
          `DELETE FROM document_chunks
           WHERE source_path = $1
             AND NOT (chunk_hash = ANY($2::text[]))`,
          [sourcePath, chunkHashes],
        );
  return result.rowCount ?? 0;
}

export async function deleteChunksForMissingPaths(
  database: Queryable,
  sourcePaths: string[],
): Promise<number> {
  const result =
    sourcePaths.length === 0
      ? await database.query("DELETE FROM document_chunks")
      : await database.query(
          `DELETE FROM document_chunks
           WHERE NOT (source_path = ANY($1::text[]))`,
          [sourcePaths],
        );
  return result.rowCount ?? 0;
}
