import type {
  CodeRelationshipRecord,
  CodeSymbolRecord,
  IndexScope,
  RelationshipType,
  SymbolType,
} from "@review/shared";
import type { Pool } from "pg";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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
  private readonly clauses: string[] = [];
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
  id: string;
  repo: string;
  revision: string;
  branch_tag: string | null;
  index_scope: IndexScope;
  review_id: string | null;
  symbol_type: SymbolType;
  symbol_name: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  signature: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  commit_sha: string;
  content_hash: string;
}

export async function lookupSymbols(opts: {
  pool: Pool;
  repoIds?: string[];
  symbolTypes?: SymbolType[];
  nameContains?: string;
  filePaths?: string[];
  indexScope?: IndexScope;
  reviewId?: string;
  commitSha?: string;
  limit?: number;
}): Promise<CodeSymbolRecord[]> {
  if (
    opts.repoIds?.length === 0 ||
    opts.symbolTypes?.length === 0 ||
    opts.filePaths?.length === 0
  ) {
    return [];
  }
  const where = new Where();
  if (opts.repoIds) where.add("repo = ANY(?::text[])", opts.repoIds);
  if (opts.symbolTypes) where.add("symbol_type = ANY(?::text[])", opts.symbolTypes);
  if (opts.filePaths) where.add("file_path = ANY(?::text[])", opts.filePaths);
  if (opts.nameContains) {
    where.add("symbol_name ILIKE ?", `%${escapeLike(opts.nameContains)}%`);
  }
  if (opts.commitSha) where.add("commit_sha = ?", opts.commitSha);
  where.addScope(opts.indexScope, opts.reviewId);

  where.params.push(clampLimit(opts.limit));
  const result = await opts.pool.query<SymbolRow>(
    `SELECT id, repo, revision, branch_tag, index_scope, review_id, symbol_type,
            symbol_name, file_path, line_start, line_end, signature, summary,
            metadata, commit_sha, content_hash
     FROM code_symbols ${where.sql()}
     ORDER BY repo, file_path, line_start NULLS LAST, id
     LIMIT $${where.params.length}`,
    where.params,
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    repo: row.repo,
    revision: row.revision,
    branchTag: row.branch_tag,
    indexScope: row.index_scope,
    reviewId: row.review_id,
    symbolType: row.symbol_type,
    symbolName: row.symbol_name,
    filePath: row.file_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    signature: row.signature,
    summary: row.summary,
    metadata: row.metadata ?? {},
    commitSha: row.commit_sha,
    contentHash: row.content_hash,
  }));
}

interface RelationshipRow {
  id: string;
  repo: string;
  index_scope: IndexScope;
  review_id: string | null;
  commit_sha: string;
  source_symbol_id: string;
  target_symbol_id: string | null;
  target_name: string | null;
  relationship_type: RelationshipType;
  file_path: string | null;
  line_start: number | null;
}

export async function lookupRelationships(opts: {
  pool: Pool;
  sourceSymbolId?: number;
  repoIds?: string[];
  relationshipTypes?: RelationshipType[];
  indexScope?: IndexScope;
  reviewId?: string;
  limit?: number;
}): Promise<CodeRelationshipRecord[]> {
  if (opts.repoIds?.length === 0 || opts.relationshipTypes?.length === 0) {
    return [];
  }
  const where = new Where();
  if (opts.sourceSymbolId !== undefined) {
    where.add("source_symbol_id = ?", opts.sourceSymbolId);
  }
  if (opts.repoIds) where.add("repo = ANY(?::text[])", opts.repoIds);
  if (opts.relationshipTypes) {
    where.add("relationship_type = ANY(?::text[])", opts.relationshipTypes);
  }
  where.addScope(opts.indexScope, opts.reviewId);

  where.params.push(clampLimit(opts.limit));
  const result = await opts.pool.query<RelationshipRow>(
    `SELECT id, repo, index_scope, review_id, commit_sha, source_symbol_id,
            target_symbol_id, target_name, relationship_type, file_path, line_start
     FROM code_relationships ${where.sql()}
     ORDER BY id
     LIMIT $${where.params.length}`,
    where.params,
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    repo: row.repo,
    indexScope: row.index_scope,
    reviewId: row.review_id,
    commitSha: row.commit_sha,
    sourceSymbolId: Number(row.source_symbol_id),
    targetSymbolId: row.target_symbol_id === null ? null : Number(row.target_symbol_id),
    targetName: row.target_name,
    relationshipType: row.relationship_type,
    filePath: row.file_path,
    lineStart: row.line_start,
  }));
}
