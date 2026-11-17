# Phase 3 Code Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse .NET and Angular sources into persistent `code_symbols` / `code_relationships`, support baseline and PR-delta indexing with cleanup, and expose symbol/relationship retrieval APIs—without implementing the three remaining MCP tools or Teams.

**Architecture:** New `@review/code-intel` owns file discovery, language parsers, store upserts, baseline/PR index orchestration, and lookup helpers. TypeScript/Angular uses the TypeScript Compiler API; C#/.NET uses Node `tree-sitter` + `tree-sitter-c-sharp` (no .NET SDK required for tests). `@review/db` gains migration `004_code_intelligence.sql`. `@review/git-manager` adds changed-file listing. The orchestrator runs PR-delta indexing after worktrees/diff and deletes PR-scoped rows on cleanup. MCP tools `trace_*` / `check_reusability` stay stubs until Phase 4.

**Tech Stack:** TypeScript (Node 22+), pnpm workspaces, Vitest, Zod, `pg` + pgvector, `typescript` (compiler API), `tree-sitter` + `tree-sitter-c-sharp`, existing `@review/knowledge` `EmbeddingProvider` (optional symbol embeddings).

**Spec:** `docs/superpowers/specs/2026-11-16-review-orchestrator-prd.md` (Phase 3 §10; Code Intelligence §5.3–5.4; Index lifecycle §7; Acceptance §9 Code Intelligence — parsing/delta/retrieval only; cross-repo mismatch fixture validation is Phase 4)

## Global Constraints

- Review agent remains Claude Code only; reviews stay read-only.
- Code intelligence is logically separate from Document RAG (do not write into `document_chunks`).
- Embedding dimension remains **768** when embeddings are generated; `embedding` column is **nullable** (NULL when no embedder supplied).
- Parsers: **TypeScript Compiler API** for `.ts`/`.tsx`; **tree-sitter-c-sharp** for `.cs`. Do not require Roslyn/dotnet SDK for unit tests.
- Index isolation: `index_scope = 'baseline' | 'pr'`; PR rows carry `review_id`; baseline rows have `review_id IS NULL`. PR cleanup must never delete baseline rows.
- MCP tools `trace_fe_be_integration`, `trace_symbol_impact`, `check_reusability` remain stubs (`no_results`).
- No Teams webhook, Adaptive Cards, or Phase 5 structured findings contract work in this phase.
- DB-mutating tests use `TEST_DATABASE_URL` via `resolveTestDatabaseUrl` / `ensureDatabase` (same Phase 2 pattern).

## Review Focus

- Re-indexing a changed file must drop symbols that no longer exist in that file (stale symbol names/routes gone after parse).
- Deleting a file in a PR delta must remove PR-scoped symbols for that path without touching baseline rows for the same path.
- `cleanupPrIndex(reviewId)` must leave baseline symbols intact when the same `repo`/`file_path`/`symbol_name` exists in both scopes.
- Parse failures on a single file must be recorded and skipped; other files in the same index run must still succeed (no whole-run abort on one bad file).
- Retrieval filtered by `index_scope: "pr"` + `reviewId` must not return baseline-only hits for the same symbol name.

## Out of scope (later plans)

- Phase 4: Real `trace_fe_be_integration`, `trace_symbol_impact`, `check_reusability` MCP tools and deliberate FE/BE mismatch fixture acceptance
- Phase 5: Full review prompt + structured findings contract
- Phase 6: Teams bot, Adaptive Cards, auth, idempotency, observability hardening
- Full call-graph resolution / Roslyn semantic model / Angular language-service type checker
- Hybrid BM25 over symbols; ANN indexes over symbol embeddings (exact cosine or name lookup only)

---

## File Structure

```text
packages/
  shared/
    src/
      types.ts                 # + SymbolType, RelationshipType, CodeSymbol, …
  db/
    src/
      sql/
        004_code_intelligence.sql
      client.test.ts           # or migrate.test.ts — assert tables exist
  git-manager/
    src/
      diff.ts                  # + listChangedFiles
    tests/
      diff.test.ts             # extend
  code-intel/                  # NEW @review/code-intel
    package.json
    tsconfig.json
    vitest.config.ts
    fixtures/
      dotnet/
        OrdersController.cs
        OrderDto.cs
        OrderService.cs
        OrderValidator.cs
        Order.cs
        AppDbContext.cs
      angular/
        order.service.ts
        order.model.ts
        order-list.component.ts
    src/
      types.ts                 # ParsedSymbol, ParsedRelationship (package-local)
      discover.ts              # walk source roots by role
      parse-csharp.ts
      parse-typescript.ts
      parse.ts                 # dispatch by extension
      store.ts                 # upsert/delete symbols + relationships
      index-baseline.ts
      index-delta.ts
      cleanup.ts
      retrieve.ts
      embed-symbols.ts         # optional: text → embedding via injected provider
      cli.ts                   # index-baseline entry
      index.ts
    tests/
      discover.test.ts
      parse-csharp.test.ts
      parse-typescript.test.ts
      store.test.ts
      index-delta.test.ts
      retrieve.test.ts
      cleanup.test.ts
  orchestrator/
    src/
      review.ts                # call delta index + cleanupPrIndex
    tests/
      review.test.ts           # assert indexing hooks invoked
  mcp-server/                  # unchanged tool behavior (stubs remain)
scripts/
  smoke-phase3.sh
```

---

### Task 1: Shared types and `code_symbols` / `code_relationships` schema

**Files:**
- Create: `packages/db/src/sql/004_code_intelligence.sql`
- Modify: `packages/shared/src/types.ts`, `packages/shared/src/index.ts`
- Test: `packages/db/src/client.test.ts` (extend) or `packages/db/src/migrate.test.ts`

**Interfaces:**
- Consumes: existing `migrate(pool)` (lexicographic SQL apply)
- Produces:
  - Shared types:
    - `SymbolType = "controller" | "endpoint" | "dto" | "service_method" | "validation_rule" | "entity" | "dbcontext_config" | "angular_service" | "http_call" | "interface" | "component" | "signal"`
    - `RelationshipType = "calls" | "references" | "implements" | "maps_to" | "exposes" | "http_calls" | "validates" | "injects"`
    - `IndexScope = "baseline" | "pr"`
    - `CodeSymbolRecord = { id: number; repo: string; revision: string; branchTag: string | null; indexScope: IndexScope; reviewId: string | null; symbolType: SymbolType; symbolName: string; filePath: string; lineStart: number | null; lineEnd: number | null; signature: string; summary: string | null; metadata: Record<string, unknown>; commitSha: string; contentHash: string }`
    - `CodeRelationshipRecord = { id: number; repo: string; indexScope: IndexScope; reviewId: string | null; commitSha: string; sourceSymbolId: number; targetSymbolId: number | null; targetName: string | null; relationshipType: RelationshipType; filePath: string | null; lineStart: number | null }`
  - Table `code_symbols`:
    - Columns matching PRD §5.4 plus: `index_scope VARCHAR(20) NOT NULL`, `review_id VARCHAR(100)`, `metadata JSONB NOT NULL DEFAULT '{}'`, `content_hash VARCHAR(64) NOT NULL`, `embedding vector(768)` **nullable**
    - Check: `index_scope IN ('baseline','pr')`
    - Check: `(index_scope = 'baseline' AND review_id IS NULL) OR (index_scope = 'pr' AND review_id IS NOT NULL)`
    - Indexes: `(repo, index_scope, review_id)`, `(repo, commit_sha)`, `(repo, file_path)`, `(symbol_type, symbol_name)`
    - No UNIQUE on natural key; store layer deletes-by-file then inserts (same as document chunk file replace)
  - Table `code_relationships`:
    - `id BIGSERIAL PRIMARY KEY`
    - `repo`, `index_scope`, `review_id`, `commit_sha` as above
    - `source_symbol_id BIGINT NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE`
    - `target_symbol_id BIGINT REFERENCES code_symbols(id) ON DELETE SET NULL`
    - `target_name VARCHAR(255)` (unresolved target)
    - `relationship_type VARCHAR(50) NOT NULL`
    - `file_path TEXT`, `line_start INT`
    - Index on `(source_symbol_id)`, `(repo, index_scope, review_id)`

- [ ] **Step 1: Write the failing test**

```ts
it("migrate creates code_symbols and code_relationships", async () => {
  const url = resolveTestDatabaseUrl();
  if (!url) return;
  await ensureDatabase(url);
  const pool = createPool(url);
  await migrate(pool);
  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('code_symbols', 'code_relationships')
  `);
  expect(tables.rows.map((r) => r.table_name).sort()).toEqual([
    "code_relationships",
    "code_symbols",
  ]);
  const emb = await pool.query(`
    SELECT udt_name, is_nullable FROM information_schema.columns
    WHERE table_name = 'code_symbols' AND column_name = 'embedding'
  `);
  expect(emb.rows[0]?.udt_name).toBe("vector");
  expect(emb.rows[0]?.is_nullable).toBe("YES");
  await pool.end();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://review:review@localhost:5433/review_test pnpm --filter @review/db test`
Expected: FAIL (tables missing) after `docker compose up -d`

- [ ] **Step 3: Add shared types and `004_code_intelligence.sql`**

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://review:review@localhost:5433/review_test pnpm --filter @review/db test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared packages/db
git commit -m "feat: add code_symbols and code_relationships schema"
```

---

### Task 2: TypeScript / Angular parser and fixtures

**Files:**
- Create: `packages/code-intel/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/types.ts`, `src/parse-typescript.ts`, `src/index.ts`, `fixtures/angular/*`
- Test: `packages/code-intel/tests/parse-typescript.test.ts`

**Interfaces:**
- Consumes: `SymbolType`, `RelationshipType` from `@review/shared`
- Produces:
  - Package-local:
    - `ParsedSymbol = { symbolType: SymbolType; symbolName: string; filePath: string; lineStart: number; lineEnd: number; signature: string; summary?: string; metadata?: Record<string, unknown> }`
    - `ParsedRelationship = { sourceName: string; sourceType: SymbolType; targetName: string; relationshipType: RelationshipType; filePath: string; lineStart: number }`
    - `ParseFileResult = { symbols: ParsedSymbol[]; relationships: ParsedRelationship[]; errors: string[] }`
  - `parseTypeScriptFile(opts: { filePath: string; sourceText: string }): ParseFileResult`
  - Must extract from fixtures:
    - `@Injectable` class → `angular_service`
    - `HttpClient` `.get/.post/.put/.patch/.delete('…')` → `http_call` with `metadata: { httpMethod, path }`
    - `export interface` → `interface`
    - `@Component` class → `component` (inputs/outputs in `metadata` when present)
    - `signal(` / `input(` / `output(` public members → `signal` when clearly present
  - Relationships: `http_calls` from service method name to path string as `targetName`; `injects` from component to service type name when constructor/`inject()` visible
  - Dependency: `typescript` (use `ts.createSourceFile` + walk; no full program type-checker required)

- [ ] **Step 1: Write fixtures and failing tests**

```ts
it("parses Angular OrderService HttpClient calls and interface", () => {
  const source = readFixture("angular/order.service.ts");
  const result = parseTypeScriptFile({
    filePath: "src/app/order.service.ts",
    sourceText: source,
  });
  expect(result.symbols.some((s) => s.symbolType === "angular_service" && s.symbolName === "OrderService")).toBe(true);
  const http = result.symbols.find((s) => s.symbolType === "http_call");
  expect(http?.metadata).toMatchObject({ httpMethod: "GET", path: "/api/orders" });
  expect(result.relationships.some((r) => r.relationshipType === "http_calls")).toBe(true);
});

it("parses component and interface from fixtures", () => {
  const model = parseTypeScriptFile({
    filePath: "order.model.ts",
    sourceText: readFixture("angular/order.model.ts"),
  });
  expect(model.symbols.some((s) => s.symbolType === "interface" && s.symbolName === "OrderDto")).toBe(true);
});
```

Fixture `order.service.ts` must include a real `HttpClient.get('/api/orders')` (or template-literal path) and `@Injectable`. Fixture `order-list.component.ts` must `@Component` and inject `OrderService`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/code-intel test -- parse-typescript.test.ts`
Expected: FAIL (package/parser missing)

- [ ] **Step 3: Scaffold `@review/code-intel` and implement `parseTypeScriptFile`**

Workspace already includes `packages/*`. Export parsers from `src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @review/code-intel test -- parse-typescript.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/code-intel
git commit -m "feat: parse Angular TypeScript symbols for code intel"
```

---

### Task 3: C# / .NET parser and fixtures

**Files:**
- Create: `packages/code-intel/src/parse-csharp.ts`, `fixtures/dotnet/*`
- Modify: `packages/code-intel/package.json` (deps: `tree-sitter`, `tree-sitter-c-sharp`)
- Test: `packages/code-intel/tests/parse-csharp.test.ts`

**Interfaces:**
- Consumes: `ParsedSymbol`, `ParsedRelationship`, `ParseFileResult`
- Produces:
  - `parseCSharpFile(opts: { filePath: string; sourceText: string }): ParseFileResult`
  - Must extract from fixtures:
    - `[ApiController]` / `*Controller` class → `controller`
    - `[HttpGet]/`HttpPost`/…] method → `endpoint` with `metadata: { httpMethod, route }` (combine class Route + method template when present)
    - `record` / DTO-like class ending in `Dto` or in `*Models*` path → `dto`
    - public methods on `*Service` classes → `service_method`
    - `AbstractValidator<T>` subclass → `validation_rule` with relationship `validates` → `T`
    - EF entity class with key props → `entity`
    - `DbContext` / `IEntityTypeConfiguration<T>` → `dbcontext_config`
  - Relationships: `exposes` from controller/endpoint to route string as `targetName`; `validates` from validator to DTO type name
  - Init tree-sitter language once (lazy singleton); syntax errors → empty symbols + `errors` entry, not throw

- [ ] **Step 1: Write fixtures and failing tests**

```ts
it("parses controller endpoints and DTO", () => {
  const result = parseCSharpFile({
    filePath: "OrdersController.cs",
    sourceText: readFixture("dotnet/OrdersController.cs"),
  });
  expect(result.symbols.some((s) => s.symbolType === "controller" && /OrdersController/.test(s.symbolName))).toBe(true);
  const ep = result.symbols.find((s) => s.symbolType === "endpoint");
  expect(ep?.metadata).toMatchObject({ httpMethod: "GET" });
  expect(String(ep?.metadata?.route ?? "")).toMatch(/orders/i);
});

it("parses FluentValidation and entity", () => {
  const v = parseCSharpFile({
    filePath: "OrderValidator.cs",
    sourceText: readFixture("dotnet/OrderValidator.cs"),
  });
  expect(v.symbols.some((s) => s.symbolType === "validation_rule")).toBe(true);
  expect(v.relationships.some((r) => r.relationshipType === "validates" && r.targetName === "OrderDto")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/code-intel test -- parse-csharp.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `parseCSharpFile` with tree-sitter-c-sharp**

Pin `tree-sitter` / `tree-sitter-c-sharp` versions that install on Node 22 darwin/linux; if native binding fails in CI, document the pin fix in the commit message—do not switch to Roslyn.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @review/code-intel test -- parse-csharp.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/code-intel
git commit -m "feat: parse .NET C# symbols for code intel"
```

---

### Task 4: Discover, parse dispatch, store, and baseline index

**Files:**
- Create: `packages/code-intel/src/{discover,parse,store,index-baseline,embed-symbols,cli}.ts`
- Test: `packages/code-intel/tests/{discover,store}.test.ts` (+ baseline coverage in store or dedicated test)

**Interfaces:**
- Consumes: parsers, `Pool`, `RepoConfig`, optional `EmbeddingProvider` from `@review/knowledge`
- Produces:
  - `discoverSourceFiles(opts: { rootDir: string; role: RepoRole }): Promise<string[]>` — relative paths; backend: `**/*.cs` excluding `bin/`, `obj/`; frontend: `**/*.{ts,tsx}` excluding `node_modules/`, `dist/`, `*.d.ts`
  - `parseSourceFile(opts: { filePath: string; sourceText: string }): ParseFileResult` — `.cs` → C#; `.ts`/`.tsx` → TS; else `{ symbols: [], relationships: [], errors: ["unsupported"] }`
  - `replaceFileSymbols(opts: { pool; repo; indexScope; reviewId; commitSha; branchTag; filePath; contentHash; symbols; relationships; embedding? }): Promise<void>`
    - DELETE FROM code_symbols WHERE repo+scope+review_id+file_path match (CASCADE relationships)
    - INSERT symbols; then INSERT relationships resolving `target_symbol_id` when a symbol with `targetName` exists in the same replace batch or already in DB for that scope; else leave `target_symbol_id` NULL and set `target_name`
  - `isFileCurrent(opts: { pool; repo; indexScope; reviewId; filePath; contentHash }): Promise<boolean>` — true if any row exists with same content_hash
  - `indexBaseline(opts: { pool; repo: RepoConfig; commitSha: string; branchTag: string; rootDir: string; embedder?: EmbeddingProvider }): Promise<BaselineIndexReport>`
  - `BaselineIndexReport = { filesSeen: number; filesSkippedUnchanged: number; filesParsed: number; symbolsUpserted: number; filesFailed: number }`
  - Algorithm per file: hash utf8 → skip if `isFileCurrent` → parse → on parse errors still count `filesFailed` but continue → optional embed of `signature + "\n" + (summary ?? "")` → `replaceFileSymbols`
  - After walk: delete baseline symbols whose `file_path` is not in discovered set for that repo (`deleteBaselineMissingFiles`)
  - CLI: `pnpm --filter @review/code-intel index-baseline -- --repo-id <id>` loads `loadConfig(env)`, resolves repo, uses `repo.localPath` + `defaultBaseBranch` as `branchTag`, reads HEAD sha via `git rev-parse HEAD` in that path, migrates, indexes; print report JSON

- [ ] **Step 1: Write the failing tests**

```ts
it("discoverSourceFiles finds cs and skips bin", async () => {
  const files = await discoverSourceFiles({ rootDir: fixtureDotnetRoot, role: "backend" });
  expect(files.some((f) => f.endsWith("OrdersController.cs"))).toBe(true);
  expect(files.every((f) => !f.includes(`${sep}bin${sep}`))).toBe(true);
});

it("replaceFileSymbols removes stale symbols on reindex", async () => {
  // insert endpoint Foo then re-parse file without Foo
  await replaceFileSymbols({ /* … symbols: [Foo] */ });
  await replaceFileSymbols({ /* … symbols: [Bar only] */ });
  const rows = await pool.query(`SELECT symbol_name FROM code_symbols WHERE file_path = $1`, [file]);
  expect(rows.rows.map((r) => r.symbol_name)).toEqual(["Bar"]);
});

it("indexBaseline skips unchanged content_hash", async () => {
  const r1 = await indexBaseline({ /* fixtures root, fake embedder optional */ });
  const r2 = await indexBaseline({ /* same */ });
  expect(r2.filesSkippedUnchanged).toBeGreaterThan(0);
  expect(r2.symbolsUpserted).toBe(0);
});

it("indexBaseline continues after one unparseable file", async () => {
  // root contains OrdersController.cs plus broken.cs with truncated/invalid tokens
  const report = await indexBaseline({ rootDir: mixedFixtureRoot, /* … */ });
  expect(report.filesFailed).toBeGreaterThanOrEqual(1);
  expect(report.symbolsUpserted).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TEST_DATABASE_URL=… pnpm --filter @review/code-intel test -- discover.test.ts store.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement discover, parse dispatch, store, baseline index, CLI**

`@review/code-intel` depends on `@review/db`, `@review/shared`, `@review/knowledge` (for `EmbeddingProvider` type + `createEmbeddingProvider` in CLI only).

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=… pnpm --filter @review/code-intel test -- discover.test.ts store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/code-intel
git commit -m "feat: baseline-index code symbols into pgvector store"
```

---

### Task 5: Changed files, PR delta index, cleanup, and retrieval

**Files:**
- Modify: `packages/git-manager/src/diff.ts`, `packages/git-manager/src/index.ts`, `packages/git-manager/tests/diff.test.ts`
- Create: `packages/code-intel/src/{index-delta,cleanup,retrieve}.ts`
- Test: `packages/code-intel/tests/{index-delta,cleanup,retrieve}.test.ts`

**Interfaces:**
- Consumes: `replaceFileSymbols`, `isFileCurrent`, `parseSourceFile`, worktree paths
- Produces:
  - `listChangedFiles(opts: { worktreePath: string; targetBranch: string }): Promise<{ addedOrModified: string[]; deleted: string[] }>`
    - `git diff --name-only --diff-filter=ACMR ${target}...HEAD`
    - `git diff --name-only --diff-filter=D ${target}...HEAD`
    - Normalize `targetBranch` with `origin/` prefix same as `focusedDiff`
  - `indexPrDelta(opts: { pool; repoId; reviewId; commitSha; branchTag; rootDir; targetBranch; worktreePath; role; listChangedFiles?; embedder? }): Promise<DeltaIndexReport>`
  - `DeltaIndexReport = { filesConsidered: number; filesParsed: number; filesDeleted: number; symbolsUpserted: number; filesFailed: number }`
  - For each added/modified path that `discover` would accept: read from worktree → replace into `index_scope='pr'`
  - For each deleted path: `DELETE FROM code_symbols WHERE repo=$1 AND index_scope='pr' AND review_id=$2 AND file_path=$3`
  - Do not modify baseline rows
  - `cleanupPrIndex(pool, reviewId: string): Promise<{ symbolsDeleted: number }>` — delete all `code_symbols` where `review_id = $1` (relationships CASCADE)
  - `lookupSymbols(opts: { pool; repoIds?: string[]; symbolTypes?: SymbolType[]; nameContains?: string; filePaths?: string[]; indexScope?: IndexScope; reviewId?: string; commitSha?: string; limit?: number }): Promise<CodeSymbolRecord[]>` — default `limit` 50; max 200
  - `lookupRelationships(opts: { pool; sourceSymbolId?: number; repoIds?: string[]; relationshipTypes?: RelationshipType[]; indexScope?: IndexScope; reviewId?: string; limit?: number }): Promise<CodeRelationshipRecord[]>` — default limit 50; max 200
  - Empty filters that match nothing → `[]` (callers map to MCP `no_results` in Phase 4)

- [ ] **Step 1: Write the failing tests**

```ts
// git-manager diff.test.ts
it("listChangedFiles separates modified and deleted", async () => {
  // reuse fixture-repo pattern: commit file, modify one, delete one on branch
  const { addedOrModified, deleted } = await listChangedFiles({
    worktreePath,
    targetBranch: "main",
  });
  expect(addedOrModified).toContain("src/a.ts");
  expect(deleted).toContain("src/gone.ts");
});

// index-delta.test.ts
it("PR delta indexes modified file under review_id without touching baseline", async () => {
  await indexBaseline({ repoId: "be", /* OrdersController baseline */ });
  await indexPrDelta({
    reviewId: "rev-1",
    /* modified controller in temp dir */,
  });
  const baseline = await lookupSymbols({ pool, repoIds: ["be"], indexScope: "baseline", nameContains: "Orders" });
  const pr = await lookupSymbols({ pool, repoIds: ["be"], indexScope: "pr", reviewId: "rev-1", nameContains: "Orders" });
  expect(baseline.length).toBeGreaterThan(0);
  expect(pr.length).toBeGreaterThan(0);
  expect(pr.every((s) => s.reviewId === "rev-1")).toBe(true);
});

it("deleted file removes only PR-scoped symbols", async () => {
  // baseline + pr rows for path; delta deleted list includes path
  await indexPrDelta({ /* deleted: [path] */ });
  const pr = await lookupSymbols({ pool, indexScope: "pr", reviewId: "rev-1", filePaths: [path] });
  const baseline = await lookupSymbols({ pool, indexScope: "baseline", filePaths: [path] });
  expect(pr).toEqual([]);
  expect(baseline.length).toBeGreaterThan(0);
});

// cleanup.test.ts
it("cleanupPrIndex deletes pr rows only", async () => {
  await cleanupPrIndex(pool, "rev-1");
  expect(await lookupSymbols({ pool, reviewId: "rev-1" })).toEqual([]);
  expect((await lookupSymbols({ pool, indexScope: "baseline", repoIds: ["be"] })).length).toBeGreaterThan(0);
});

// retrieve.test.ts
it("lookupSymbols nameContains is case-insensitive and respects indexScope", async () => {
  const prOnly = await lookupSymbols({
    pool,
    nameContains: "orders",
    indexScope: "pr",
    reviewId: "rev-1",
  });
  expect(prOnly.every((s) => s.indexScope === "pr")).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm --filter @review/git-manager test -- diff.test.ts
TEST_DATABASE_URL=… pnpm --filter @review/code-intel test -- index-delta.test.ts cleanup.test.ts retrieve.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement `listChangedFiles`, delta index, cleanup, retrieve**

- [ ] **Step 4: Run tests to verify they pass**

Run: same commands as Step 2  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/git-manager packages/code-intel
git commit -m "feat: PR delta index, cleanup, and symbol retrieval"
```

---

### Task 6: Orchestrator wiring, smoke script, README

**Files:**
- Modify: `packages/orchestrator/src/review.ts`, `packages/orchestrator/package.json`, `packages/orchestrator/tests/review.test.ts`, root `package.json`, `README.md`, `.env.example` (optional note only)
- Create: `scripts/smoke-phase3.sh`

**Interfaces:**
- Consumes: `indexPrDelta`, `cleanupPrIndex`, `listChangedFiles`, existing `runReview`
- Produces:
  - Extend `ReviewDeps` with optional:
    - `indexPrDelta?: typeof indexPrDelta`
    - `cleanupPrIndex?: typeof cleanupPrIndex`
    - `dbPoolFactory?: (url: string) => Pool` (default `createPool`)
  - After focused diff and before Claude: if `requireDb` (or new flag defaulting to `requireDb`), open pool → for primary and companion repos call `indexPrDelta` with that repo’s worktree, role, head sha, `request.reviewId`
  - On indexing failure: set review `status: "failed"`, `error.code: "index_failed"`, still run cleanup
  - In `finally` cleanup path: after worktree removal (or before), call `cleanupPrIndex(pool, request.reviewId)` when DB was used; ignore cleanup errors
  - Unit test: inject mock `indexPrDelta` / `cleanupPrIndex`; assert both called with `reviewId` on success path; assert `cleanupPrIndex` called when Claude fails
  - Smoke: docker up → migrate → `EMBEDDING_PROVIDER=fake` baseline-index both fixture trees into test DB (or copy fixtures to temp “repos”) → run code-intel + git-manager + orchestrator tests → print `Phase 3 smoke OK`
  - README: Phase 3 section — parsers chosen, baseline CLI, delta-on-review behavior, note that MCP trace tools still stubbed

- [ ] **Step 1: Write the failing orchestrator test**

```ts
it("runs PR delta indexing and cleans up PR index", async () => {
  const indexPrDelta = vi.fn(async () => ({
    filesConsidered: 1,
    filesParsed: 1,
    filesDeleted: 0,
    symbolsUpserted: 2,
    filesFailed: 0,
  }));
  const cleanupPrIndex = vi.fn(async () => ({ symbolsDeleted: 2 }));
  const result = await runReview(request, {
    …deps,
    requireDb: true,
    indexPrDelta,
    cleanupPrIndex,
    runClaude: async () => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false }),
  });
  expect(result.status).toBe("completed");
  expect(indexPrDelta).toHaveBeenCalled();
  expect(cleanupPrIndex).toHaveBeenCalledWith(expect.anything(), request.reviewId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/orchestrator test -- review.test.ts`
Expected: FAIL (hooks not wired)

- [ ] **Step 3: Wire orchestrator, smoke script, README**

Keep MCP stubs unchanged. Do not implement Phase 4 tools.

- [ ] **Step 4: Run tests and smoke**

Run:
```bash
pnpm test
EMBEDDING_PROVIDER=fake ./scripts/smoke-phase3.sh
```
Expected: all PASS; smoke prints `Phase 3 smoke OK`

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator packages/code-intel scripts/smoke-phase3.sh package.json README.md .env.example
git commit -m "feat: wire PR code indexing into review lifecycle"
```

---

## Self-Review

1. **Spec coverage:** §5.3 backend/frontend symbol kinds → Tasks 2–3; §5.4 schema → Task 1; baseline + delta + revision traceability → Tasks 4–5; §7 PR cleanup without deleting baseline → Tasks 5–6; §9 parsing/delta/retrieval → Tasks 2–5; §9 cross-repo mismatch fixture → deferred to Phase 4 (explicit). Phase 3 §10 bullets all mapped.
2. **Step scan:** Signatures, enums, SQL checks, git diff filters, limits (50/200), and status `index_failed` are pinned; parser walk bodies left to implementers.
3. **Type consistency:** `SymbolType`, `RelationshipType`, `IndexScope`, `ParseFileResult`, `BaselineIndexReport`, `DeltaIndexReport`, `lookupSymbols` / `lookupRelationships` used consistently across tasks.
4. **Review Focus:** stale file symbols → Task 4 replace test; deleted file PR-only → Task 5; cleanup vs baseline → Task 5; single-file parse failure → Task 4 `filesFailed` continue (add assertion in baseline/delta report test if missing during implementation); scope-filtered retrieve → Task 5.
5. **Proportion:** Plan locks interfaces and isolation rules; does not paste full parser implementations.

**Review Focus → owning tests (explicit):**

| Failure mode | Task / test |
|---|---|
| Stale symbols after file reindex | Task 4 `replaceFileSymbols removes stale symbols` |
| Deleted file vs baseline | Task 5 `deleted file removes only PR-scoped symbols` |
| cleanup vs baseline | Task 5 `cleanupPrIndex deletes pr rows only` |
| Single-file parse failure continues | Task 4/5: index report `filesFailed >= 1` and `filesParsed` still increments for good files — add to `indexBaseline` or `indexPrDelta` test with one broken `.cs` beside a valid fixture |
| PR retrieve excludes baseline-only | Task 5 `lookupSymbols … respects indexScope` |
