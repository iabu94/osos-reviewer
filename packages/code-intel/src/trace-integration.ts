import type {
  CodeSymbolRecord,
  IndexScope,
  IntegrationMismatch,
  SymbolEvidence,
  SymbolType,
} from "@osos-reviewer/shared";
import type { Pool } from "pg";

import { mergePreferPr } from "./merge-scope.js";
import { httpContractKey, normalizeRoutePath } from "./normalize-route.js";
import { lookupSymbols } from "./retrieve.js";

const DEFAULT_MISMATCH_LIMIT = 20;
const MAX_MISMATCH_LIMIT = 50;
const SYMBOL_LOAD_LIMIT = 200;

const TRACE_SYMBOL_TYPES: SymbolType[] = ["endpoint", "http_call", "dto", "interface"];

function clampMismatchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_MISMATCH_LIMIT;
  }
  return Math.min(MAX_MISMATCH_LIMIT, Math.max(1, Math.trunc(limit)));
}

function toEvidence(row: CodeSymbolRecord): SymbolEvidence {
  return {
    repo: row.repo,
    symbolName: row.symbolName,
    symbolType: row.symbolType,
    filePath: row.filePath,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    signature: row.signature,
  };
}

function metadataString(meta: Record<string, unknown>, key: string): string | undefined {
  const v = meta[key];
  return typeof v === "string" ? v : undefined;
}

function propertiesOf(row: CodeSymbolRecord): string[] {
  const raw = row.metadata?.properties;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === "string");
}

function propertySet(props: string[]): Set<string> {
  return new Set(props.map((p) => p.toLowerCase()));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

/** Extract candidate DTO/type names shared by naming convention. */
function typeNamesInSignature(signature: string): string[] {
  const names = signature.match(/\b[A-Z][A-Za-z0-9_]*Dto\b/g) ?? [];
  return [...new Set(names)];
}

function endpointRoute(row: CodeSymbolRecord): string {
  const route = metadataString(row.metadata, "route");
  return route ?? row.symbolName;
}

function endpointKey(row: CodeSymbolRecord): string {
  const method = metadataString(row.metadata, "httpMethod") ?? "GET";
  return httpContractKey(method, endpointRoute(row));
}

function httpCallKey(row: CodeSymbolRecord): string {
  const method = metadataString(row.metadata, "httpMethod") ?? "GET";
  const path = metadataString(row.metadata, "path") ?? row.symbolName;
  return httpContractKey(method, path);
}

function findTypeRow(
  symbols: CodeSymbolRecord[],
  repoIds: string[],
  typeName: string,
  allowed: SymbolType[],
): CodeSymbolRecord | undefined {
  return symbols.find(
    (s) =>
      repoIds.includes(s.repo) &&
      allowed.includes(s.symbolType) &&
      s.symbolName === typeName,
  );
}

function mismatchDedupeKey(m: IntegrationMismatch): string {
  const path = normalizeRoutePath(String(m.detail?.path ?? ""));
  const method = (m.detail?.httpMethod ?? "").toUpperCase();
  let dtoName = "";
  if (m.kind === "shape_mismatch") {
    const match = m.summary.match(/^DTO shape differs for (\S+) on /);
    dtoName = match?.[1] ?? "";
  }
  return `${m.kind}\0${path}\0${method}\0${dtoName}`;
}

function dedupeMismatches(items: IntegrationMismatch[]): IntegrationMismatch[] {
  const seen = new Set<string>();
  const out: IntegrationMismatch[] = [];
  for (const m of items) {
    const key = mismatchDedupeKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

async function loadSymbolsForScope(
  base: { pool: Pool; repoIds: string[]; limit: number },
  indexScope: IndexScope,
  reviewId?: string,
): Promise<CodeSymbolRecord[]> {
  const rows: CodeSymbolRecord[] = [];
  for (const symbolType of TRACE_SYMBOL_TYPES) {
    rows.push(
      ...(await lookupSymbols({
        ...base,
        symbolTypes: [symbolType],
        indexScope,
        reviewId: indexScope === "pr" ? reviewId : undefined,
      })),
    );
  }
  return rows;
}

async function loadScopedSymbols(opts: {
  pool: Pool;
  repoIds: string[];
  indexScope?: IndexScope;
  reviewId?: string;
}): Promise<CodeSymbolRecord[]> {
  const base = { pool: opts.pool, repoIds: opts.repoIds, limit: SYMBOL_LOAD_LIMIT };
  if (opts.reviewId) {
    const pr = await loadSymbolsForScope(base, "pr", opts.reviewId);
    const baseline = await loadSymbolsForScope(base, "baseline");
    return mergePreferPr([...pr, ...baseline]);
  }
  if (opts.indexScope) {
    return loadSymbolsForScope(
      base,
      opts.indexScope,
      opts.indexScope === "pr" ? opts.reviewId : undefined,
    );
  }
  return loadSymbolsForScope(base, "baseline");
}

export async function traceFeBeIntegration(opts: {
  pool: Pool;
  backendRepoIds: string[];
  frontendRepoIds: string[];
  indexScope?: IndexScope;
  reviewId?: string;
  limit?: number;
  includeUnmatchedBackend?: boolean;
}): Promise<IntegrationMismatch[]> {
  const repoIds = [...opts.backendRepoIds, ...opts.frontendRepoIds];
  const symbols = await loadScopedSymbols({
    pool: opts.pool,
    repoIds,
    indexScope: opts.indexScope,
    reviewId: opts.reviewId,
  });

  const endpoints = symbols.filter(
    (s) => opts.backendRepoIds.includes(s.repo) && s.symbolType === "endpoint",
  );
  const httpCalls = symbols.filter(
    (s) => opts.frontendRepoIds.includes(s.repo) && s.symbolType === "http_call",
  );

  const backendByKey = new Map<string, CodeSymbolRecord>();
  const backendByPath = new Map<string, CodeSymbolRecord[]>();
  for (const ep of endpoints) {
    const key = endpointKey(ep);
    backendByKey.set(key, ep);
    const path = normalizeRoutePath(endpointRoute(ep));
    const list = backendByPath.get(path) ?? [];
    list.push(ep);
    backendByPath.set(path, list);
  }

  const frontendKeys = new Set<string>();
  const mismatches: IntegrationMismatch[] = [];

  for (const call of httpCalls) {
    const method = metadataString(call.metadata, "httpMethod") ?? "GET";
    const path = metadataString(call.metadata, "path") ?? call.symbolName;
    const key = httpCallKey(call);
    frontendKeys.add(key);

    const backend = backendByKey.get(key);
    if (backend) {
      const feTypes = typeNamesInSignature(call.signature);
      const beTypes = typeNamesInSignature(backend.signature);
      const shared = feTypes.filter((t) => beTypes.includes(t));
      for (const typeName of shared) {
        const beDto = findTypeRow(symbols, opts.backendRepoIds, typeName, ["dto"]);
        const feDto = findTypeRow(symbols, opts.frontendRepoIds, typeName, ["interface", "dto"]);
        const beProps = beDto ? propertiesOf(beDto) : [];
        const feProps = feDto ? propertiesOf(feDto) : [];
        if (beProps.length === 0 || feProps.length === 0) continue;
        if (setsEqual(propertySet(beProps), propertySet(feProps))) continue;
        mismatches.push({
          kind: "shape_mismatch",
          summary: `DTO shape differs for ${typeName} on ${key}`,
          frontend: toEvidence(feDto ?? call),
          backend: toEvidence(beDto ?? backend),
          detail: {
            httpMethod: method,
            path,
            frontendProperties: feProps,
            backendProperties: beProps,
          },
        });
      }
      continue;
    }

    const normPath = normalizeRoutePath(path);
    const samePath = backendByPath.get(normPath) ?? [];
    const methodPeer = samePath.find(
      (ep) =>
        (metadataString(ep.metadata, "httpMethod") ?? "GET").toUpperCase() !== method.toUpperCase(),
    );
    if (methodPeer) {
      mismatches.push({
        kind: "method_mismatch",
        summary: `HTTP method mismatch for ${normPath}: frontend ${method.toUpperCase()}, backend ${metadataString(methodPeer.metadata, "httpMethod") ?? "GET"}`,
        frontend: toEvidence(call),
        backend: toEvidence(methodPeer),
        detail: { httpMethod: method, path },
      });
      continue;
    }

    mismatches.push({
      kind: "missing_backend",
      summary: `No backend endpoint for frontend call ${key}`,
      frontend: toEvidence(call),
      detail: { httpMethod: method, path },
    });
  }

  if (opts.includeUnmatchedBackend) {
    for (const ep of endpoints) {
      const key = endpointKey(ep);
      if (frontendKeys.has(key)) continue;
      const method = metadataString(ep.metadata, "httpMethod") ?? "GET";
      const path = endpointRoute(ep);
      mismatches.push({
        kind: "missing_frontend",
        summary: `No frontend HTTP call for backend endpoint ${key}`,
        backend: toEvidence(ep),
        detail: { httpMethod: method, path },
      });
    }
  }

  return dedupeMismatches(mismatches).slice(0, clampMismatchLimit(opts.limit));
}