import type { EmbeddingProvider } from "@review/knowledge";
import type {
  IndexScope,
  ReusabilityCandidate,
  SymbolType,
} from "@review/shared";
import type { Pool } from "pg";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

const VECTOR_EXPLANATION =
  "Vector similarity candidate — verify before treating as duplication.";
const NAME_EXPLANATION =
  "Name/signature match candidate — verify before treating as duplication.";

const NAME_FALLBACK_SCORE = 0.5;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

class Where {
  readonly clauses: string[] = [];
  readonly params: unknown[] = [];

  add(clause: string, value: unknown): void {
    this.params.push(value);
    this.clauses.push(clause.replace("?", `$${this.params.length}`));
  }

  addScope(indexScope: IndexScope | undefined, reviewId: string | undefined): void {
    if (indexScope) {
      this.add("index_scope = ?", indexScope);
    }
    if (reviewId !== undefined) {
      this.add("review_id = ?", reviewId);
    } else if (indexScope === "baseline") {
      this.clauses.push("review_id IS NULL");
    }
  }

  sql(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(" AND ")}` : "";
  }
}

interface SymbolRow {
  repo: string;
  symbol_type: SymbolType;
  symbol_name: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  signature: string;
  distance: number;
}

function mapCandidate(
  row: Omit<SymbolRow, "distance">,
  score: number,
  explanation: string,
): ReusabilityCandidate {
  return {
    repo: row.repo,
    symbolName: row.symbol_name,
    symbolType: row.symbol_type,
    filePath: row.file_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    signature: row.signature,
    score,
    explanation,
  };
}

function cloneWhere(base: Where): Where {
  const copy = new Where();
  copy.clauses.push(...base.clauses);
  copy.params.push(...base.params);
  return copy;
}

async function findByNameMatch(
  pool: Pool,
  scopeWhere: Where,
  query: string,
  limit: number,
): Promise<ReusabilityCandidate[]> {
  const pattern = `%${escapeLike(query)}%`;
  const where = cloneWhere(scopeWhere);
  where.params.push(pattern, pattern);
  const nameParam = `$${where.params.length - 1}`;
  const sigParam = `$${where.params.length}`;
  where.clauses.push(`(symbol_name ILIKE ${nameParam} OR signature ILIKE ${sigParam})`);
  where.params.push(limit);
  const limitParam = `$${where.params.length}`;

  const result = await pool.query<SymbolRow>(
    `SELECT repo, symbol_type, symbol_name, file_path, line_start, line_end, signature
     FROM code_symbols ${where.sql()}
     ORDER BY repo, file_path, line_start NULLS LAST, symbol_name
     LIMIT ${limitParam}`,
    where.params,
  );

  return result.rows.map((row) => mapCandidate(row, NAME_FALLBACK_SCORE, NAME_EXPLANATION));
}

export async function findSimilarSymbols(opts: {
  pool: Pool;
  embedder: EmbeddingProvider;
  query: string;
  repoIds?: string[];
  symbolTypes?: SymbolType[];
  indexScope?: IndexScope;
  reviewId?: string;
  limit?: number;
}): Promise<ReusabilityCandidate[]> {
  if (opts.indexScope === "pr" && opts.reviewId === undefined) {
    return [];
  }
  if (opts.repoIds?.length === 0 || opts.symbolTypes?.length === 0) {
    return [];
  }
  const trimmed = opts.query.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const limit = clampLimit(opts.limit);
  const where = new Where();
  if (opts.repoIds) where.add("repo = ANY(?::text[])", opts.repoIds);
  if (opts.symbolTypes) where.add("symbol_type = ANY(?::text[])", opts.symbolTypes);
  where.addScope(opts.indexScope, opts.reviewId);

  const embeddedWhere = cloneWhere(where);
  embeddedWhere.clauses.push("embedding IS NOT NULL");

  const countResult = await opts.pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM code_symbols ${embeddedWhere.sql()}`,
    embeddedWhere.params,
  );
  const embeddedCount = Number(countResult.rows[0]?.n ?? 0);

  if (embeddedCount === 0) {
    return findByNameMatch(opts.pool, where, trimmed, limit);
  }

  const [embedding] = await opts.embedder.embed([trimmed]);
  const vector = `[${embedding.join(",")}]`;
  const queryWhere = cloneWhere(embeddedWhere);
  queryWhere.params.push(vector, limit);
  const vecParam = `$${queryWhere.params.length - 1}`;
  const limitParam = `$${queryWhere.params.length}`;

  const result = await opts.pool.query<SymbolRow>(
    `SELECT repo, symbol_type, symbol_name, file_path, line_start, line_end,
            signature, embedding <=> ${vecParam}::vector AS distance
     FROM code_symbols ${embeddedWhere.sql()}
     ORDER BY embedding <=> ${vecParam}::vector ASC
     LIMIT ${limitParam}`,
    queryWhere.params,
  );

  return result.rows.map((row) =>
    mapCandidate(row, 1 / (1 + Number(row.distance)), VECTOR_EXPLANATION),
  );
}