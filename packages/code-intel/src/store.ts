import type { IndexScope } from "@osos-reviewer/shared";
import type { Pool } from "pg";

import type { ParsedRelationship, ParsedSymbol } from "./types.js";

const NAME_MAX = 255;

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function toVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export interface ReplaceFileSymbolsOptions {
  pool: Pool;
  repo: string;
  indexScope: IndexScope;
  reviewId: string | null;
  commitSha: string;
  branchTag: string | null;
  filePath: string;
  contentHash: string;
  symbols: ParsedSymbol[];
  relationships: ParsedRelationship[];
  /** Optional vectors aligned by index with `symbols`; `null` leaves a symbol un-embedded. */
  embedding?: Array<number[] | null>;
}

interface InsertedSymbol {
  id: number;
  name: string;
  type: string;
}

function resolveSource(
  inserted: InsertedSymbol[],
  rel: ParsedRelationship,
): number | undefined {
  const pick = (name: string): number | undefined => {
    const matches = inserted.filter((s) => s.name === name);
    return (matches.find((s) => s.type === rel.sourceType) ?? matches[0])?.id;
  };
  const exact = pick(rel.sourceName);
  if (exact !== undefined) {
    return exact;
  }
  const dot = rel.sourceName.lastIndexOf(".");
  return dot > 0 ? pick(rel.sourceName.slice(0, dot)) : undefined;
}

/**
 * Replaces every symbol (and, via cascade, relationship) stored for one file in
 * one repo/scope/review. Relationships whose source cannot be resolved to a
 * symbol in the batch are skipped.
 */
export async function replaceFileSymbols(
  opts: ReplaceFileSymbolsOptions,
): Promise<void> {
  const client = await opts.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM code_symbols
       WHERE repo = $1 AND index_scope = $2
         AND review_id IS NOT DISTINCT FROM $3 AND file_path = $4`,
      [opts.repo, opts.indexScope, opts.reviewId, opts.filePath],
    );

    const inserted: InsertedSymbol[] = [];
    for (const [index, symbol] of opts.symbols.entries()) {
      const embedding = opts.embedding?.[index] ?? null;
      const result = await client.query<{ id: string }>(
        `INSERT INTO code_symbols (
           repo, revision, branch_tag, index_scope, review_id, symbol_type,
           symbol_name, file_path, line_start, line_end, signature, summary,
           metadata, content_hash, embedding, commit_sha
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
                 $14, $15::vector, $16)
         RETURNING id`,
        [
          opts.repo,
          opts.commitSha,
          opts.branchTag,
          opts.indexScope,
          opts.reviewId,
          symbol.symbolType,
          clip(symbol.symbolName, NAME_MAX),
          opts.filePath,
          symbol.lineStart,
          symbol.lineEnd,
          symbol.signature,
          symbol.summary ?? null,
          JSON.stringify(symbol.metadata ?? {}),
          opts.contentHash,
          embedding ? toVector(embedding) : null,
          opts.commitSha,
        ],
      );
      inserted.push({
        id: Number(result.rows[0].id),
        name: clip(symbol.symbolName, NAME_MAX),
        type: symbol.symbolType,
      });
    }

    const dbTargetCache = new Map<string, number | null>();
    const resolveTarget = async (name: string): Promise<number | null> => {
      const inBatch = inserted.find((s) => s.name === name);
      if (inBatch) {
        return inBatch.id;
      }
      if (dbTargetCache.has(name)) {
        return dbTargetCache.get(name) ?? null;
      }
      const found = await client.query<{ id: string }>(
        `SELECT id FROM code_symbols
         WHERE repo = $1 AND index_scope = $2
           AND review_id IS NOT DISTINCT FROM $3 AND symbol_name = $4
         ORDER BY id LIMIT 1`,
        [opts.repo, opts.indexScope, opts.reviewId, name],
      );
      const id = found.rows[0] ? Number(found.rows[0].id) : null;
      dbTargetCache.set(name, id);
      return id;
    };

    for (const rel of opts.relationships) {
      const sourceId = resolveSource(inserted, rel);
      if (sourceId === undefined) {
        continue;
      }
      const targetName = clip(rel.targetName, NAME_MAX);
      const targetId = await resolveTarget(targetName);
      await client.query(
        `INSERT INTO code_relationships (
           repo, index_scope, review_id, commit_sha, source_symbol_id,
           target_symbol_id, target_name, relationship_type, file_path, line_start
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          opts.repo,
          opts.indexScope,
          opts.reviewId,
          opts.commitSha,
          sourceId,
          targetId,
          targetName,
          rel.relationshipType,
          opts.filePath,
          rel.lineStart,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function isFileCurrent(opts: {
  pool: Pool;
  repo: string;
  indexScope: IndexScope;
  reviewId: string | null;
  filePath: string;
  contentHash: string;
}): Promise<boolean> {
  const result = await opts.pool.query(
    `SELECT 1 FROM code_symbols
     WHERE repo = $1 AND index_scope = $2
       AND review_id IS NOT DISTINCT FROM $3
       AND file_path = $4 AND content_hash = $5
     LIMIT 1`,
    [opts.repo, opts.indexScope, opts.reviewId, opts.filePath, opts.contentHash],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Deletes baseline symbols (cascading relationships) for files no longer discovered. */
export async function deleteBaselineMissingFiles(opts: {
  pool: Pool;
  repo: string;
  filePaths: string[];
}): Promise<number> {
  const result = await opts.pool.query(
    `DELETE FROM code_symbols
     WHERE repo = $1 AND index_scope = 'baseline' AND review_id IS NULL
       AND NOT (file_path = ANY($2::text[]))`,
    [opts.repo, opts.filePaths],
  );
  return result.rowCount ?? 0;
}
