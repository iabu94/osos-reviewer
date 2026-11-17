import type {
  CodeSymbolRecord,
  ImpactedSymbol,
  IndexScope,
  RelationshipType,
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

async function findSeedSymbols(opts: TraceOpts): Promise<CodeSymbolRecord[]> {
  const base = {
    pool: opts.pool,
    repoIds: opts.repoIds,
    indexScope: opts.indexScope,
    reviewId: opts.reviewId,
    limit: SYMBOL_LOAD_LIMIT,
  };
  const rows = await lookupSymbols(base);
  let seeds = rows.filter((s) => s.symbolName === opts.symbolName);
  if (seeds.length === 0) {
    const lower = opts.symbolName.toLowerCase();
    seeds = rows.filter((s) => s.symbolName.toLowerCase() === lower);
  }
  return mergePreferPr(seeds);
}

function resolveByExactName(
  symbols: CodeSymbolRecord[],
  name: string,
): CodeSymbolRecord | undefined {
  const exact = symbols.filter((s) => s.symbolName === name);
  if (exact.length === 0) return undefined;
  return mergePreferPr(exact)[0];
}

export async function traceSymbolImpact(opts: TraceOpts): Promise<ImpactedSymbol[]> {
  const maxDepth = clampMaxDepth(opts.maxDepth);
  const limit = clampLimit(opts.limit);

  const seeds = await findSeedSymbols(opts);
  if (seeds.length === 0) return [];

  const scopeSymbols = await lookupSymbols({
    pool: opts.pool,
    repoIds: opts.repoIds,
    indexScope: opts.indexScope,
    reviewId: opts.reviewId,
    limit: SYMBOL_LOAD_LIMIT,
  });
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
      } else if (edge.targetName) {
        target = resolveByExactName(scopeSymbols, edge.targetName);
        if (!target) {
          const extra = await lookupSymbols({
            pool: opts.pool,
            repoIds: opts.repoIds,
            indexScope: opts.indexScope,
            reviewId: opts.reviewId,
            nameContains: edge.targetName,
            limit: SYMBOL_LOAD_LIMIT,
          });
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