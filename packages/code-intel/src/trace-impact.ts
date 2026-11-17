import type {
  CodeSymbolRecord,
  ImpactedSymbol,
  IndexScope,
  RelationshipType,
  SymbolType,
} from "@review/shared";
import type { Pool } from "pg";

import { mergePreferPr } from "./merge-scope.js";
import { lookupRelationships, lookupSymbols } from "./retrieve.js";

const DEFAULT_MAX_DEPTH = 2;
const MAX_MAX_DEPTH = 4;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const SYMBOL_LOAD_LIMIT = 200;

function clampMaxDepth(maxDepth: number | undefined): number {
  if (maxDepth === undefined || !Number.isFinite(maxDepth)) {
    return DEFAULT_MAX_DEPTH;
  }
  return Math.min(MAX_MAX_DEPTH, Math.max(0, Math.trunc(maxDepth)));
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function toImpacted(
  row: CodeSymbolRecord,
  via: RelationshipType | "seed",
  depth: number,
): ImpactedSymbol {
  return {
    repo: row.repo,
    symbolName: row.symbolName,
    symbolType: row.symbolType,
    filePath: row.filePath,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    signature: row.signature,
    via,
    depth,
  };
}

type TraceOpts = {
  pool: Pool;
  symbolName: string;
  repoIds?: string[];
  indexScope?: IndexScope;
  reviewId?: string;
  maxDepth?: number;
  limit?: number;
};

function scopeBase(opts: TraceOpts): {
  pool: Pool;
  repoIds?: string[];
  limit: number;
} {
  return {
    pool: opts.pool,
    repoIds: opts.repoIds,
    limit: SYMBOL_LOAD_LIMIT,
  };
}

async function loadScopeSymbols(opts: TraceOpts): Promise<CodeSymbolRecord[]> {
  const base = scopeBase(opts);
  if (opts.reviewId) {
    const pr = await lookupSymbols({
      ...base,
      indexScope: "pr",
      reviewId: opts.reviewId,
    });
    const baseline = await lookupSymbols({ ...base, indexScope: "baseline" });
    return mergePreferPr([...pr, ...baseline]);
  }
  if (opts.indexScope) {
    return lookupSymbols({
      ...base,
      indexScope: opts.indexScope,
      reviewId: opts.indexScope === "pr" ? opts.reviewId : undefined,
    });
  }
  return lookupSymbols(base);
}

async function lookupInScope(
  opts: TraceOpts,
  nameFilter: {
    symbolNameEquals?: string;
    symbolNameEqualsCi?: string;
    nameContains?: string;
  },
): Promise<CodeSymbolRecord[]> {
  const base = { ...scopeBase(opts), ...nameFilter };
  if (opts.reviewId) {
    const pr = await lookupSymbols({
      ...base,
      indexScope: "pr",
      reviewId: opts.reviewId,
    });
    const baseline = await lookupSymbols({ ...base, indexScope: "baseline" });
    return mergePreferPr([...pr, ...baseline]);
  }
  if (opts.indexScope) {
    return lookupSymbols({
      ...base,
      indexScope: opts.indexScope,
      reviewId: opts.indexScope === "pr" ? opts.reviewId : undefined,
    });
  }
  return lookupSymbols(base);
}

async function lookupByNameContains(
  opts: TraceOpts,
  nameContains: string,
): Promise<CodeSymbolRecord[]> {
  return lookupInScope(opts, { nameContains });
}

async function findSeedSymbols(opts: TraceOpts): Promise<CodeSymbolRecord[]> {
  let seeds = await lookupInScope(opts, { symbolNameEquals: opts.symbolName });
  if (seeds.length === 0) {
    seeds = await lookupInScope(opts, { symbolNameEqualsCi: opts.symbolName });
  }
  return seeds;
}

function resolveByExactName(
  symbols: CodeSymbolRecord[],
  name: string,
): CodeSymbolRecord | undefined {
  const exact = symbols.filter((s) => s.symbolName === name);
  if (exact.length === 0) return undefined;
  return mergePreferPr(exact)[0];
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

function mapSymbolRow(row: SymbolRow): CodeSymbolRecord {
  return {
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
  };
}

async function fetchSymbolById(pool: Pool, symbolId: number): Promise<CodeSymbolRecord | undefined> {
  const result = await pool.query<SymbolRow>(
    `SELECT id, repo, revision, branch_tag, index_scope, review_id, symbol_type,
            symbol_name, file_path, line_start, line_end, signature, summary,
            metadata, commit_sha, content_hash
     FROM code_symbols WHERE id = $1`,
    [symbolId],
  );
  const row = result.rows[0];
  return row ? mapSymbolRow(row) : undefined;
}

export async function traceSymbolImpact(opts: TraceOpts): Promise<ImpactedSymbol[]> {
  const maxDepth = clampMaxDepth(opts.maxDepth);
  const limit = clampLimit(opts.limit);

  const seeds = await findSeedSymbols(opts);
  if (seeds.length === 0) return [];

  const scopeSymbols = await loadScopeSymbols(opts);
  const symbolById = new Map<number, CodeSymbolRecord>();
  for (const row of scopeSymbols) symbolById.set(row.id, row);

  const visited = new Set<number>();
  const result: ImpactedSymbol[] = [];
  const queue: Array<{ symbolId: number; depth: number; via: RelationshipType | "seed" }> = [];

  for (const seed of seeds) {
    if (visited.has(seed.id)) continue;
    visited.add(seed.id);
    symbolById.set(seed.id, seed);
    result.push(toImpacted(seed, "seed", 0));
    if (0 < maxDepth) {
      queue.push({ symbolId: seed.id, depth: 0, via: "seed" });
    }
  }

  while (queue.length > 0 && result.length < limit) {
    const current = queue.shift()!;
    const edges = await lookupRelationships({
      pool: opts.pool,
      sourceSymbolId: current.symbolId,
      repoIds: opts.repoIds,
      indexScope: opts.indexScope,
      reviewId: opts.reviewId,
      limit: SYMBOL_LOAD_LIMIT,
    });

    for (const edge of edges) {
      if (result.length >= limit) break;

      let target: CodeSymbolRecord | undefined;
      if (edge.targetSymbolId !== null) {
        target = symbolById.get(edge.targetSymbolId);
        if (!target) {
          target = await fetchSymbolById(opts.pool, edge.targetSymbolId);
          if (target) symbolById.set(target.id, target);
        }
      } else if (edge.targetName) {
        target = resolveByExactName(scopeSymbols, edge.targetName);
        if (!target) {
          const extra = await lookupByNameContains(opts, edge.targetName);
          target = resolveByExactName(extra, edge.targetName);
        }
        if (target) symbolById.set(target.id, target);
      }
      if (!target || visited.has(target.id)) continue;

      const nextDepth = current.depth + 1;
      visited.add(target.id);
      result.push(toImpacted(target, edge.relationshipType, nextDepth));
      if (nextDepth < maxDepth) {
        queue.push({ symbolId: target.id, depth: nextDepth, via: edge.relationshipType });
      }
    }
  }

  return result;
}