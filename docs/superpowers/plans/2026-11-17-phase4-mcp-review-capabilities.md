# Phase 4 MCP Review Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three Phase 1 MCP stubs with real, independently testable tools—`trace_fe_be_integration`, `trace_symbol_impact`, and `check_reusability`—backed by `@review/code-intel` tracers that detect a deliberate FE/BE contract mismatch in fixtures.

**Architecture:** Tracing and similarity live in `@review/code-intel` (unit-tested against indexed fixtures). `@review/mcp-server` becomes a thin Zod + payload-bound adapter, same pattern as Phase 2 `get_coding_standards`. Parsers gain DTO/interface property names in `metadata.properties` so shape mismatches are detectable. No Claude prompt rewrite, no Teams.

**Tech Stack:** TypeScript (Node 22+), pnpm workspaces, Vitest, Zod, `pg` + pgvector, existing `@review/code-intel` lookup/store APIs, existing `@review/knowledge` `EmbeddingProvider` for similarity.

**Spec:** `docs/superpowers/specs/2026-11-16-review-orchestrator-prd.md` (Phase 4 §10; MCP Tools §5.6 Tools 1–3 + design requirements; Acceptance §9 Code Intelligence cross-repo mismatch + MCP structured/bounded responses)

## Global Constraints

- Review agent remains Claude Code only; tools stay read-only (no shell, no repo writes).
- Every tool returns `McpToolResult` with `status: "ok" | "no_results" | "service_error"` and distinguishes empty evidence from failures.
- Bound every ok/no_results payload: `JSON.stringify(result).length < 12_000` (same cap as `get_coding_standards`).
- Embedding dimension remains **768**; similarity queries filter `embedding IS NOT NULL` and never mix models (store has no per-row model column—require caller `embedder.modelId` only for query embedding; skip rows without vectors).
- DB-mutating tests use `TEST_DATABASE_URL` via `resolveTestDatabaseUrl` / `ensureDatabase` (never `DATABASE_URL`).
- Keep `get_coding_standards` behavior unchanged.
- No Phase 5 structured findings contract, review prompt rewrite, or Teams Adaptive Cards.

## Review Focus

- When FE calls a route/method with no matching BE endpoint, `trace_fe_be_integration` returns a mismatch (not silent `ok` with empty evidence mistaken for “contracts match”).
- When BE and FE DTO/interface property sets diverge after case-folding, the tool reports a `shape_mismatch` with both symbol locations.
- `trace_symbol_impact` with unknown symbol name returns `no_results`, not `service_error`.
- `check_reusability` labels hits as candidates (explanation text must not claim confirmed duplication).
- PR-scoped queries with `reviewId` must prefer PR symbol rows over baseline for the same `(repo, filePath, symbolName)` key.

## Out of scope (later plans)

- Phase 5: Full review prompt + structured findings contract + restricted Claude tool permissions beyond what already exists
- Phase 6: Teams bot, Adaptive Cards, auth, idempotency, observability hardening
- Full call-graph / Roslyn semantic model / Angular language-service resolution
- Hybrid BM25; ANN indexes over symbol embeddings (exact `<=>` only)
- Cross-repo `maps_to` edges stored at index time (Phase 4 matches HTTP contracts at query time)

---

## File Structure

```text
packages/
  shared/
    src/
      types.ts                 # + IntegrationMismatch, ImpactedSymbol, ReusabilityCandidate, …
      index.ts
  code-intel/
    fixtures/
      mismatch/                # NEW deliberate broken FE/BE pair
        backend/
          BrokenOrdersController.cs
          BrokenOrderDto.cs
        frontend/
          broken-order.service.ts
          broken-order.model.ts
      dotnet/ …                # existing (happy-path + property metadata via parser)
      angular/ …
    src/
      normalize-route.ts       # NEW
      merge-scope.ts           # NEW prefer PR over baseline
      trace-integration.ts     # NEW
      trace-impact.ts          # NEW
      find-similar.ts          # NEW
      parse-csharp.ts          # + metadata.properties on DTOs
      parse-typescript.ts      # + metadata.properties on interfaces
      retrieve.ts              # unchanged API; tracers call it
      index.ts                 # re-exports
    tests/
      normalize-route.test.ts
      merge-scope.test.ts
      parse-csharp.test.ts     # extend properties
      parse-typescript.test.ts # extend properties
      trace-integration.test.ts
      trace-impact.test.ts
      find-similar.test.ts
  mcp-server/
    src/
      tools/
        stubs.ts               # remove three stub handlers (keep McpToolResult type)
        result.ts              # NEW shared boundPayload helper (or keep local)
        trace_fe_be_integration.ts
        trace_symbol_impact.ts
        check_reusability.ts
        get_coding_standards.ts  # unchanged
        router.ts              # route all four live tools
      server.ts                # real ListTools schemas/descriptions
    package.json               # + @review/code-intel
    tests/
      tools.test.ts            # drop stub expectations; unknown_tool only
      trace_fe_be_integration.test.ts
      trace_symbol_impact.test.ts
      check_reusability.test.ts
scripts/
  smoke-phase4.sh
```

---

### Task 1: Shared evidence types, route normalization, scope merge, DTO property metadata

**Files:**
- Modify: `packages/shared/src/types.ts`, `packages/shared/src/index.ts`
- Create: `packages/code-intel/src/normalize-route.ts`, `packages/code-intel/src/merge-scope.ts`
- Modify: `packages/code-intel/src/parse-csharp.ts`, `packages/code-intel/src/parse-typescript.ts`, `packages/code-intel/src/index.ts`
- Test: `packages/code-intel/tests/normalize-route.test.ts`, `packages/code-intel/tests/merge-scope.test.ts`; extend `parse-csharp.test.ts`, `parse-typescript.test.ts`

**Interfaces:**
- Consumes: existing parsers, `CodeSymbolRecord`
- Produces:
  - Shared:
    - `IntegrationMismatchKind = "missing_backend" | "missing_frontend" | "method_mismatch" | "shape_mismatch"`
    - `SymbolEvidence = { repo: string; symbolName: string; symbolType: SymbolType; filePath: string; lineStart: number | null; lineEnd: number | null; signature: string }`
    - `IntegrationMismatch = { kind: IntegrationMismatchKind; summary: string; frontend?: SymbolEvidence; backend?: SymbolEvidence; detail?: { httpMethod?: string; path?: string; frontendProperties?: string[]; backendProperties?: string[] } }`
    - `ImpactedSymbol = SymbolEvidence & { via: RelationshipType | "seed"; depth: number }`
    - `ReusabilityCandidate = SymbolEvidence & { score: number; explanation: string }`
  - `normalizeRoutePath(path: string): string` — trim; strip leading `/`; lowercase; replace `{…}`, `:param`, and `${…}` segments with `{param}`; collapse duplicate `/`; no trailing slash except empty → `""`
  - `httpContractKey(method: string, path: string): string` → `${method.toUpperCase()} ${normalizeRoutePath(path)}`
  - `mergePreferPr(symbols: CodeSymbolRecord[]): CodeSymbolRecord[]` — key `(repo, filePath, symbolName)`; if any row has `indexScope === "pr"`, keep that row; else keep baseline
  - Parser: C# `dto` symbols include `metadata.properties: string[]` (record primary params + public properties). TS exported `interface` symbols include `metadata.properties: string[]` (property declarations’ names). Keep existing `members` count on interfaces for back-compat or replace with `properties.length`—tests assert `properties`.

- [ ] **Step 1: Write the failing tests**

```ts
// normalize-route.test.ts
it("normalizes ASP.NET and Angular path templates to the same key", () => {
  expect(httpContractKey("GET", "/api/orders/{id:int}")).toBe(
    httpContractKey("get", "/api/orders/${id}"),
  );
  expect(normalizeRoutePath("API/Orders/")).toBe("api/orders");
});

// merge-scope.test.ts
it("prefers PR row over baseline for the same key", () => {
  const merged = mergePreferPr([
    { repo: "be", filePath: "a.cs", symbolName: "X", indexScope: "baseline", /* … */ },
    { repo: "be", filePath: "a.cs", symbolName: "X", indexScope: "pr", reviewId: "r1", /* … */ },
  ]);
  expect(merged).toHaveLength(1);
  expect(merged[0].indexScope).toBe("pr");
});

// parse-*.test.ts
it("dto/interface metadata includes property names", () => {
  // OrderDto / CreateOrderRequest from existing fixtures
  expect(dto?.metadata?.properties).toEqual(expect.arrayContaining(["Id", "CustomerId", "Total"]));
  expect(iface?.metadata?.properties).toEqual(
    expect.arrayContaining(["id", "customerName", "total"]),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm --filter @review/code-intel test -- normalize-route.test.ts merge-scope.test.ts parse-csharp.test.ts parse-typescript.test.ts
```
Expected: FAIL (missing modules / properties)

- [ ] **Step 3: Implement shared types, `normalizeRoutePath` / `httpContractKey`, `mergePreferPr`, and parser `metadata.properties`**

- [ ] **Step 4: Run tests to verify they pass**

Run: same command as Step 2  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared packages/code-intel
git commit -m "feat: add MCP evidence types, route keys, and DTO property metadata"
```

---

### Task 2: `traceFeBeIntegration` + deliberate mismatch fixtures

**Files:**
- Create: `packages/code-intel/src/trace-integration.ts`
- Create: `packages/code-intel/fixtures/mismatch/backend/{BrokenOrdersController.cs,BrokenOrderDto.cs}`, `packages/code-intel/fixtures/mismatch/frontend/{broken-order.service.ts,broken-order.model.ts}`
- Modify: `packages/code-intel/src/index.ts`
- Test: `packages/code-intel/tests/trace-integration.test.ts`

**Interfaces:**
- Consumes: `lookupSymbols`, `mergePreferPr`, `httpContractKey`, `normalizeRoutePath`, parsers via `indexBaseline` or `replaceFileSymbols`
- Produces:
  - `traceFeBeIntegration(opts: { pool: Pool; backendRepoIds: string[]; frontendRepoIds: string[]; indexScope?: IndexScope; reviewId?: string; limit?: number }): Promise<IntegrationMismatch[]>`
  - Default `limit` 20; max 50
  - Load symbols: if `reviewId` set, fetch `indexScope:"pr"` for that id **and** `indexScope:"baseline"`, then `mergePreferPr`; else baseline only (or explicit `indexScope`)
  - Backend contracts: `symbolType === "endpoint"` with `metadata.httpMethod` + (`metadata.route` ?? symbolName)
  - Frontend contracts: `symbolType === "http_call"` with `metadata.httpMethod` + `metadata.path`
  - Emit:
    - `missing_backend` — FE key with no BE key
    - `missing_frontend` — only when `opts.includeUnmatchedBackend === true` (default **false**; avoid noise)
    - `method_mismatch` — same normalized path, different methods, only if no exact key match exists for that FE call
    - `shape_mismatch` — for matched contracts, if caller can resolve DTO/interface names from signatures/metadata (`metadata` may include response type later; Phase 4: match by shared simple type name appearing in both endpoint signature and http_call signature, e.g. `OrderDto`), compare `metadata.properties` case-insensitively; report only if both sides have non-empty properties and sets differ
  - Fixture mismatch (must be detectable):
    - BE: `[Route("api/orders")]` + `[HttpGet]` list endpoint, DTO properties `Id`, `CustomerId`, `Total`
    - FE: `http.post('/api/order', …)` (wrong path **and** method vs GET list) + interface `BrokenOrderDto` with `id`, `customerName`, `total` (for a separate matched pair if you add a matching GET that still has shape drift—or assert `missing_backend` on the POST `/api/order` call as the primary acceptance case)
  - Primary acceptance assertion: indexing mismatch fixtures → `traceFeBeIntegration` returns at least one mismatch with `kind: "missing_backend"` whose detail path normalizes to `api/order`
  - Secondary: index **existing** happy-path fixtures (`fixtures/dotnet` + `fixtures/angular`); for the matched `GET api/orders` pair, if both `OrderDto` property lists load, expect a `shape_mismatch` (`CustomerId` vs `customerName`) **or** document that happy-path shape check is optional when type-name linkage is ambiguous—prefer implementing name linkage via signature substring `OrderDto` so this assertion is required

- [ ] **Step 1: Write the failing test**

```ts
it("detects missing backend for deliberate FE path mismatch", async () => {
  await indexBaseline({ pool, repoId: "be-bad", rootDir: mismatchBackend, role: "backend", /* … */ });
  await indexBaseline({ pool, repoId: "fe-bad", rootDir: mismatchFrontend, role: "frontend", /* … */ });
  const mismatches = await traceFeBeIntegration({
    pool,
    backendRepoIds: ["be-bad"],
    frontendRepoIds: ["fe-bad"],
  });
  expect(mismatches.some((m) => m.kind === "missing_backend")).toBe(true);
  expect(
    mismatches.some(
      (m) =>
        m.kind === "missing_backend" &&
        normalizeRoutePath(String(m.detail?.path ?? "")).includes("api/order"),
    ),
  ).toBe(true);
});

it("flags OrderDto shape drift on matching GET api/orders", async () => {
  // index existing fixtures/dotnet + fixtures/angular as be/fe
  const mismatches = await traceFeBeIntegration({
    pool,
    backendRepoIds: ["be"],
    frontendRepoIds: ["fe"],
  });
  expect(mismatches.some((m) => m.kind === "shape_mismatch")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://review:review@localhost:5433/review_test pnpm --filter @review/code-intel test -- trace-integration.test.ts`  
Expected: FAIL

- [ ] **Step 3: Add mismatch fixtures and implement `traceFeBeIntegration`**

- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/code-intel
git commit -m "feat: trace FE/BE integration mismatches from indexed symbols"
```

---

### Task 3: `traceSymbolImpact`

**Files:**
- Create: `packages/code-intel/src/trace-impact.ts`
- Modify: `packages/code-intel/src/index.ts`
- Test: `packages/code-intel/tests/trace-impact.test.ts`

**Interfaces:**
- Consumes: `lookupSymbols`, `lookupRelationships`, `mergePreferPr`
- Produces:
  - `traceSymbolImpact(opts: { pool: Pool; symbolName: string; repoIds?: string[]; indexScope?: IndexScope; reviewId?: string; maxDepth?: number; limit?: number }): Promise<ImpactedSymbol[]>`
  - `symbolName` min length 1 (caller/MCP validates); match seeds with `nameContains` **or** exact `symbol_name =` — use **exact** match first via `lookupSymbols` + filter `symbolName === opts.symbolName`, if empty fall back to case-insensitive equality only (not substring) to avoid huge fan-out
  - Default `maxDepth` 2; max 4. Default `limit` 50; max 100
  - BFS over `lookupRelationships({ sourceSymbolId })`; for unresolved `targetSymbolId === null`, resolve `targetName` with exact name lookup in same scope merge; include edge types: all `RelationshipType` values
  - Each node: map to `ImpactedSymbol` with `via` = relationship that discovered it (`"seed"` for seeds); skip duplicates by symbol id
  - Empty seeds → `[]`

- [ ] **Step 1: Write the failing test**

```ts
it("returns seed and relationship targets for OrdersController", async () => {
  // index fixtures/dotnet; seed "OrdersController"
  const impacted = await traceSymbolImpact({
    pool,
    symbolName: "OrdersController",
    repoIds: ["be"],
    maxDepth: 2,
  });
  expect(impacted[0]?.via).toBe("seed");
  expect(impacted.some((i) => i.symbolName.includes("Orders") || i.filePath.includes("Orders"))).toBe(true);
});

it("returns empty array for unknown symbol", async () => {
  expect(await traceSymbolImpact({ pool, symbolName: "DoesNotExist_ZZZ" })).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=… pnpm --filter @review/code-intel test -- trace-impact.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement `traceSymbolImpact`**

- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/code-intel
git commit -m "feat: trace symbol impact across stored relationships"
```

---

### Task 4: `findSimilarSymbols` + reusability candidates

**Files:**
- Create: `packages/code-intel/src/find-similar.ts`
- Modify: `packages/code-intel/src/index.ts`
- Test: `packages/code-intel/tests/find-similar.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider`, `Pool`, optional `symbolTypes` filter
- Produces:
  - `findSimilarSymbols(opts: { pool: Pool; embedder: EmbeddingProvider; query: string; repoIds?: string[]; symbolTypes?: SymbolType[]; indexScope?: IndexScope; reviewId?: string; limit?: number }): Promise<ReusabilityCandidate[]>`
  - Default `limit` 5; max 10
  - Embed `query` → cosine distance `embedding <=> $vec` on `code_symbols` where `embedding IS NOT NULL`, apply same scope rules as `lookupSymbols` (PR without `reviewId` → `[]`)
  - `score = 1 / (1 + distance)`; `explanation` must be exactly one of:
    - `"Vector similarity candidate — verify before treating as duplication."`
    - or when falling back (zero embedded rows): name `ILIKE` over `symbol_name` / `signature` and explanation `"Name/signature match candidate — verify before treating as duplication."`
  - Map rows to `ReusabilityCandidate` (no claim of confirmed duplication)

- [ ] **Step 1: Write the failing test**

```ts
it("returns vector similarity candidates with non-proof explanation", async () => {
  // replaceFileSymbols with fake embedder vectors for two similar service methods
  const hits = await findSimilarSymbols({
    pool,
    embedder: fake,
    query: "list orders from api",
    repoIds: ["be"],
    limit: 3,
  });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0].explanation).toMatch(/candidate/i);
  expect(hits[0].explanation).not.toMatch(/confirmed|duplicate proof/i);
});

it("falls back to name match when embeddings are null", async () => {
  // symbols stored with embedding null
  const hits = await findSimilarSymbols({
    pool,
    embedder: fake,
    query: "OrderService",
    repoIds: ["be"],
  });
  expect(hits[0]?.explanation).toMatch(/Name\/signature match candidate/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=… EMBEDDING_PROVIDER=fake pnpm --filter @review/code-intel test -- find-similar.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement `findSimilarSymbols`**

- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/code-intel
git commit -m "feat: find similar symbols for reusability checks"
```

---

### Task 5: Live MCP tools, router, smoke, README

**Files:**
- Create: `packages/mcp-server/src/tools/trace_fe_be_integration.ts`, `trace_symbol_impact.ts`, `check_reusability.ts`, `packages/mcp-server/src/tools/bound.ts` (optional shared binder)
- Modify: `packages/mcp-server/src/tools/stubs.ts` (keep `McpToolResult` only; delete stub tool handlers / `STUB_TOOL_NAMES` or leave unused—prefer delete), `router.ts`, `server.ts`, `package.json` (+ `@review/code-intel`)
- Modify: `packages/mcp-server/tests/tools.test.ts`
- Create: `packages/mcp-server/tests/trace_fe_be_integration.test.ts`, `trace_symbol_impact.test.ts`, `check_reusability.test.ts`
- Create: `scripts/smoke-phase4.sh`
- Modify: root `package.json` (`smoke:phase4`), `README.md`

**Interfaces:**
- Consumes: `traceFeBeIntegration`, `traceSymbolImpact`, `findSimilarSymbols`, `createPool`, `migrate`, `createEmbeddingProvider`, `loadConfig`, `McpToolResult`
- Produces:
  - Input schemas (Zod):
    - `traceFeBeIntegrationInputSchema`: `{ backendRepoIds: string[]; frontendRepoIds: string[]; reviewId?: string; indexScope?: "baseline" | "pr"; limit?: number }` — both repo id arrays min length 1
    - `traceSymbolImpactInputSchema`: `{ symbolName: string; repoIds?: string[]; reviewId?: string; indexScope?: "baseline" | "pr"; maxDepth?: number; limit?: number }` — `symbolName` min 1
    - `checkReusabilityInputSchema`: `{ query: string; repoIds?: string[]; symbolTypes?: SymbolType[]; reviewId?: string; indexScope?: "baseline" | "pr"; limit?: number }` — `query` min 1
  - Handlers return:
    - invalid args → `service_error` `{ code: "invalid_args", message }`
    - thrown errors → `service_error` `{ code: "retrieval_failed", message }`
    - empty arrays → `no_results` with `{ mismatches: [] }` / `{ impacted: [] }` / `{ candidates: [] }`
    - else → `ok` with bounded arrays (drop trailing items until under 12_000 chars; never drop below 1 item when status is ok—shrink summary/signature fields first, mirror `boundRules`)
  - `RouterOptions` gains `getCodeIntelDeps: () => Promise<{ pool: Pool; embedder: EmbeddingProvider }>` (may share pool factory with standards; implement `createEnvCodeIntelDeps` lazy like Phase 2)
  - `TOOL_NAMES = ["trace_fe_be_integration", "trace_symbol_impact", "check_reusability", "get_coding_standards"]`
  - `ListTools` descriptions state real retrieval (not “Stub”)
  - Smoke: docker up → migrate → `EMBEDDING_PROVIDER=fake` baseline-index mismatch + happy fixtures into `TEST_DATABASE_URL` → run `@review/code-intel` + `@review/mcp-server` tests → print `Phase 4 smoke OK`
  - README Phase 4 section: three tools live; example MCP args; note Phase 5 still owns the review output contract

- [ ] **Step 1: Write the failing MCP tests**

```ts
it("trace_fe_be_integration returns ok mismatches for mismatch fixtures", async () => {
  const result = await handleTraceFeBeIntegration(
    { backendRepoIds: ["be-bad"], frontendRepoIds: ["fe-bad"] },
    deps,
  );
  expect(result.status).toBe("ok");
  expect(result.data.mismatches.length).toBeGreaterThan(0);
  expect(JSON.stringify(result).length).toBeLessThan(12_000);
});

it("trace_symbol_impact returns no_results for unknown symbol", async () => {
  const result = await handleTraceSymbolImpact({ symbolName: "Nope_ZZZ" }, deps);
  expect(result.status).toBe("no_results");
});

it("check_reusability returns candidates with candidate wording", async () => {
  const result = await handleCheckReusability({ query: "orders list", repoIds: ["be"] }, deps);
  expect(["ok", "no_results"]).toContain(result.status);
  if (result.status === "ok") {
    expect(result.data.candidates[0].explanation).toMatch(/candidate/i);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL=… EMBEDDING_PROVIDER=fake pnpm --filter @review/mcp-server test -- trace_fe_be_integration.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement handlers, router, server schemas, smoke script, README**

Remove stub routing for the three tools. Keep unknown tool → `service_error` / `unknown_tool`.

- [ ] **Step 4: Run tests and smoke**

Run:
```bash
pnpm test
EMBEDDING_PROVIDER=fake ./scripts/smoke-phase4.sh
```
Expected: all PASS; smoke prints `Phase 4 smoke OK`

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server packages/code-intel scripts/smoke-phase4.sh package.json README.md
git commit -m "feat: wire live MCP integration, impact, and reusability tools"
```

---

## Self-Review

1. **Spec coverage:** §5.6 Tool 1 → Task 2 + 5; Tool 2 → Task 3 + 5; Tool 3 → Task 4 + 5; MCP design (structured JSON, schemas, bounded output, no_results vs errors, independently testable) → Task 5; §9 cross-repo deliberate mismatch → Task 2 acceptance + smoke; §10 Phase 4 bullets all mapped. Phase 5 prompt/Teams deferred.
2. **Step scan:** Signatures, fixture values (`api/order`, `OrderDto`/`CustomerId`/`customerName`), status codes, and commands are pinned; algorithm bodies left to implementer except route-normalization rules and explanation copy.
3. **Type consistency:** `IntegrationMismatch`, `ImpactedSymbol`, `ReusabilityCandidate`, `McpToolResult`, `traceFeBeIntegration` / `handleTraceFeBeIntegration` naming aligned across tasks; payload keys `mismatches` / `impacted` / `candidates` match former stub empty shapes.
4. **Review Focus:** Each of the five bullets has a owning-task test (missing_backend, shape_mismatch, unknown → no_results, candidate wording, mergePreferPr).
5. **Proportion:** Plan decides interfaces/fixtures/tests; no full tracer implementations transcribed.
