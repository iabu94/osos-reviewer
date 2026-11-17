import type {
  CodingStandardRule,
  DocumentCategory,
  DocumentTechnology,
} from "@review/shared";
import type { Pool } from "pg";

import type { EmbeddingProvider } from "./embed.js";

interface RetrievalRow {
  source_path: string;
  document_title: string;
  section: string;
  category: DocumentCategory;
  technology: DocumentTechnology;
  chunk_text: string;
  distance: number;
}

export async function retrieveCodingStandards(opts: {
  pool: Pool;
  embedder: EmbeddingProvider;
  query: string;
  category?: DocumentCategory;
  technology?: DocumentTechnology;
  limit?: number;
}): Promise<CodingStandardRule[]> {
  if (opts.query.trim().length === 0) {
    return [];
  }

  const [embedding] = await opts.embedder.embed([opts.query]);
  const values: unknown[] = [`[${embedding.join(",")}]`, opts.embedder.modelId];
  // Never compare vectors from different embedding models.
  const filters: string[] = ["embedding_model = $2"];

  if (opts.category !== undefined) {
    values.push(opts.category);
    filters.push(`category = $${values.length}`);
  }
  if (opts.technology !== undefined) {
    values.push(opts.technology);
    filters.push(`technology = $${values.length}`);
  }

  const limit = Math.min(10, Math.max(0, Math.floor(opts.limit ?? 5)));
  values.push(limit);
  const whereClause = `WHERE ${filters.join(" AND ")}`;
  const result = await opts.pool.query<RetrievalRow>(
    `SELECT
       source_path,
       document_title,
       section,
       category,
       technology,
       chunk_text,
       embedding <=> $1::vector AS distance
     FROM document_chunks
     ${whereClause}
     ORDER BY embedding <=> $1::vector ASC
     LIMIT $${values.length}`,
    values,
  );

  return result.rows.map((row) => ({
    ruleText: row.chunk_text.slice(0, 1500),
    documentPath: row.source_path,
    documentTitle: row.document_title,
    section: row.section,
    category: row.category,
    technology: row.technology,
    score: 1 / (1 + Number(row.distance)),
  }));
}
