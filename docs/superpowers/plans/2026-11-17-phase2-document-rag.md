# Phase 2 Document RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Markdown engineering docs into pgvector, retrieve relevant standards on demand, and implement a real `get_coding_standards` MCP tool—without AST indexing, the other three MCP tools, or Teams.

**Architecture:** A new `@review/knowledge` package owns discovery, heading-aware chunking, pluggable embeddings, incremental ingest, and semantic retrieval. `@review/db` gains a `document_chunks` migration. The MCP server keeps three Phase 1 stubs and routes `get_coding_standards` to the knowledge retriever. Ingest runs via a dedicated CLI so the knowledge base can refresh without touching application source indexes (none exist yet).

**Tech Stack:** TypeScript (Node 22+), pnpm workspaces, Vitest, Zod, `pg` + pgvector cosine distance (`<=>`), OpenAI-compatible embeddings HTTP API (768-dim), `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-11-16-review-orchestrator-prd.md` (Phase 2 §10; Document RAG §5.5; MCP `get_coding_standards` §5.6 Tool 4; Acceptance §9 Document RAG)

## Global Constraints

- Review agent remains Claude Code only; reviews stay read-only.
- Document RAG is logically separate from code intelligence (no `code_symbols` table in this phase).
- Knowledge base root defaults to repo `knowledge-base/`; only `.md` files in Phase 2.
- Embedding dimension is **768**, matching the PRD provisional vector size; schema and providers must agree.
- Default embedding provider: OpenAI-compatible HTTP (`EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`); tests use `FakeEmbeddingProvider` (no network).
- MCP tools must not expose shell execution or unrestricted repo write access.
- `get_coding_standards` must distinguish `ok` / `no_results` / `service_error` (same `McpToolResult` shape as Phase 1).
- No Teams webhook, Adaptive Cards, AST parsers, or real implementations of `trace_fe_be_integration`, `trace_symbol_impact`, or `check_reusability`.

## Review Focus

- Deleted or renamed knowledge-base files must drop orphan chunks on the next ingest — expect zero rows for the old `source_path`.
- Unchanged file content (same content hash) must not insert duplicate chunks.
- Embedding HTTP failure during ingest or retrieve must surface `service_error` (or thrown typed error at CLI), never a silent empty `ok`.
- Category / technology filters must exclude off-filter documents even if they are semantically close.
- Empty index or zero cosine hits must return `status: "no_results"` with `{ rules: [] }`, not `service_error`.

## Out of scope (later plans)

- Phase 3: .NET / Angular AST indexing and `code_symbols`
- Phase 4: Real `trace_*` / `check_reusability` MCP tools
- Phase 5: Full review prompt + structured findings contract
- Phase 6: Teams bot, Adaptive Cards, auth, idempotency, observability hardening
- Non-Markdown document formats, hybrid BM25 keyword search beyond optional exact title/heading match helpers inside retrieve

---

## File Structure

```text
knowledge-base/
  coding-standards/
    angular/
      components.md          # sample rules for tests + smoke
      services.md
    dotnet/
      controllers.md
      repositories.md
    database/
      postgresql.md
  architecture/
    system-architecture.md
    integration-guidelines.md
  security/
    secure-development.md

packages/
  shared/
    src/
      config.ts              # + knowledgeBasePath, embedding*
      types.ts               # + EmbeddingConfig, CodingStandardRule, …
  db/
    src/
      migrate.ts             # apply all sql/*.sql in sorted order
      sql/
        001_extensions.sql   # unchanged
        002_document_chunks.sql
  knowledge/                 # NEW package @review/knowledge
    package.json
    src/
      discover.ts            # walk KB for .md paths + metadata
      chunk.ts               # heading-aware Markdown chunks
      embed.ts               # EmbeddingProvider + Fake + OpenAICompatible
      store.ts               # upsert/delete document_chunks
      retrieve.ts            # semantic + filter query
      ingest.ts              # end-to-end incremental ingest
      cli.ts                 # `ingest` entry
      index.ts
    tests/
      discover.test.ts
      chunk.test.ts
      embed.test.ts
      ingest.test.ts
      retrieve.test.ts
  mcp-server/
    src/
      tools/
        stubs.ts             # keep three stubs; stop stubbing get_coding_standards
        get_coding_standards.ts
        router.ts            # dispatch by tool name
      server.ts              # richer inputSchema for get_coding_standards
    tests/
      tools.test.ts          # stubs still no_results; standards tool covered separately
      get_coding_standards.test.ts
scripts/
  smoke-phase2.sh
```

---

### Task 1: Config, types, and sample knowledge base

**Files:**
- Create: sample Markdown under `knowledge-base/**` (replace `.gitkeep` content with real short docs matching PRD tree)
- Modify: `packages/shared/src/types.ts`, `packages/shared/src/config.ts`, `packages/shared/src/index.ts`, `.env.example`
- Test: `packages/shared/src/config.test.ts`

**Interfaces:**
- Consumes: existing `loadConfig` / `AppConfig`
- Produces:
  - `AppConfig` adds:
    - `knowledgeBasePath: string` (from `KNOWLEDGE_BASE_PATH`, default `knowledge-base` resolved against `process.cwd()` only at call sites that need absolute paths—or store as provided string)
    - `embedding: EmbeddingConfig`
  - `EmbeddingConfig`: `{ provider: "openai_compatible" | "fake"; baseUrl?: string; apiKey?: string; model: string; dimensions: 768 }`
  - Env: `EMBEDDING_PROVIDER` (`openai_compatible` | `fake`, default `openai_compatible`), `EMBEDDING_BASE_URL` (default `https://api.openai.com/v1`), `EMBEDDING_API_KEY` (required when provider is `openai_compatible`), `EMBEDDING_MODEL` (default `text-embedding-3-small`), `KNOWLEDGE_BASE_PATH` (default `knowledge-base`)
  - Types: `DocumentCategory = "coding-standards" | "architecture" | "security"`; `DocumentTechnology = "angular" | "dotnet" | "database" | "general"`; `CodingStandardRule = { ruleText: string; documentPath: string; documentTitle: string; section: string; category: DocumentCategory; technology: DocumentTechnology; score: number }`
  - Sample docs must include at least one Angular component rule and one .NET controller rule with distinctive phrasing for retrieval tests (e.g. “Prefer OnPush change detection”, “Controllers must not access DbContext directly”)

- [ ] **Step 1: Write the failing test**

```ts
it("loads knowledge base and embedding config", () => {
  const cfg = loadConfig({
    DATABASE_URL: "postgres://review:review@localhost:5433/review",
    WORKTREE_ROOT: "/tmp/review-worktrees",
    CLAUDE_CLI_PATH: "claude",
    REPOS_JSON: JSON.stringify([
      { id: "be", role: "backend", localPath: "/repos/be", defaultBaseBranch: "develop" },
      { id: "fe", role: "frontend", localPath: "/repos/fe", defaultBaseBranch: "develop" },
    ]),
    KNOWLEDGE_BASE_PATH: "/kb",
    EMBEDDING_PROVIDER: "fake",
    EMBEDDING_MODEL: "text-embedding-3-small",
  });
  expect(cfg.knowledgeBasePath).toBe("/kb");
  expect(cfg.embedding.provider).toBe("fake");
  expect(cfg.embedding.dimensions).toBe(768);
});

it("requires EMBEDDING_API_KEY when provider is openai_compatible", () => {
  expect(() =>
    loadConfig({
      /* same required base env as above */
      EMBEDDING_PROVIDER: "openai_compatible",
    }),
  ).toThrow(/EMBEDDING_API_KEY/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/shared test -- config.test.ts`
Expected: FAIL (missing fields / old loader)

- [ ] **Step 3: Extend `AppConfig` / `loadConfig` and add sample KB Markdown**

Keep Phase 1 env vars working. Dimensions hard-coded to `768` in loader (ignore env override in Phase 2). Write the PRD-shaped sample files with short, searchable rule sections.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @review/shared test -- config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared knowledge-base .env.example
git commit -m "feat: add knowledge-base samples and embedding config"
```

---

### Task 2: `document_chunks` schema and multi-file migrate

**Files:**
- Create: `packages/db/src/sql/002_document_chunks.sql`
- Modify: `packages/db/src/migrate.ts`
- Test: `packages/db/src/client.test.ts` (extend) or `packages/db/src/migrate.test.ts`

**Interfaces:**
- Consumes: `createPool`, existing `migrate`
- Produces:
  - `migrate(pool)` applies every `sql/*.sql` file in lexicographic order (idempotent)
  - Table `document_chunks`:
    - `id BIGSERIAL PRIMARY KEY`
    - `source_path TEXT NOT NULL`
    - `document_title TEXT NOT NULL`
    - `section TEXT NOT NULL`
    - `category VARCHAR(50) NOT NULL`
    - `technology VARCHAR(50) NOT NULL`
    - `chunk_text TEXT NOT NULL`
    - `content_hash VARCHAR(64) NOT NULL` (sha256 of full source file at ingest time)
    - `chunk_hash VARCHAR(64) NOT NULL` (sha256 of `source_path + "\0" + section + "\0" + chunk_text`)
    - `embedding vector(768) NOT NULL`
    - `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
    - `UNIQUE (chunk_hash)`
    - Index on `(category, technology)` and ivfflat/hnsw **or** skip ANN index in Phase 2 and use exact `<=>` (prefer exact cosine for small KB; document that choice in SQL comment)

- [ ] **Step 1: Write the failing test**

```ts
it("migrate creates document_chunks with vector(768)", async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  await migrate(pool);
  const { rows } = await pool.query(`
    SELECT column_name, udt_name
    FROM information_schema.columns
    WHERE table_name = 'document_chunks' AND column_name = 'embedding'
  `);
  expect(rows[0]?.udt_name).toBe("vector");
  await pool.end();
});
```

(Skip entire suite when `DATABASE_URL` unset, same pattern as Phase 1.)

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://review:review@localhost:5433/review pnpm --filter @review/db test`
Expected: FAIL (table missing) after `docker compose up -d`

- [ ] **Step 3: Add `002_document_chunks.sql` and make `migrate` apply all SQL files**

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://review:review@localhost:5433/review pnpm --filter @review/db test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat: add document_chunks schema for document RAG"
```

---

### Task 3: Discover Markdown and heading-aware chunking

**Files:**
- Create: `packages/knowledge/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/{discover,chunk,index}.ts`
- Test: `packages/knowledge/tests/discover.test.ts`, `packages/knowledge/tests/chunk.test.ts`
- Modify: root `pnpm-workspace.yaml` if package glob needs update (already `packages/*`)

**Interfaces:**
- Consumes: `DocumentCategory`, `DocumentTechnology` from `@review/shared`
- Produces:
  - `discoverDocuments(rootDir: string): Promise<DiscoveredDocument[]>`
  - `DiscoveredDocument`: `{ absolutePath: string; relativePath: string; category: DocumentCategory; technology: DocumentTechnology; title: string }`
  - Category = first path segment under root (`coding-standards` | `architecture` | `security`); throw/skip unknown top-level dirs
  - Technology = second segment when present and known (`angular` | `dotnet` | `database`); else `general`
  - Title = first `#` heading in file, else filename stem
  - `chunkMarkdown(markdown: string, meta: Pick<DiscoveredDocument, "relativePath" | "category" | "technology" | "title">): DocumentChunkDraft[]`
  - `DocumentChunkDraft`: `{ sourcePath: string; documentTitle: string; section: string; category; technology; chunkText: string; chunkHash: string }`
  - Split on ATX headings `##` / `###`; each chunk includes breadcrumb heading context; if no subheadings, one chunk for body under title; soft-split chunks longer than **1200** characters on paragraph boundaries (no mid-sentence requirement beyond `\n\n`)
  - `chunkHash = sha256(`${sourcePath}\0${section}\0${chunkText}`)` hex

- [ ] **Step 1: Write the failing tests**

```ts
// discover.test.ts
it("maps coding-standards/angular/components.md metadata", async () => {
  const docs = await discoverDocuments(fixtureKbRoot);
  const hit = docs.find((d) => d.relativePath.endsWith("components.md"));
  expect(hit?.category).toBe("coding-standards");
  expect(hit?.technology).toBe("angular");
});

// chunk.test.ts
it("preserves section heading in chunks", () => {
  const chunks = chunkMarkdown(
    "# Components\n\n## Change detection\n\nPrefer OnPush change detection.\n",
    {
      relativePath: "coding-standards/angular/components.md",
      category: "coding-standards",
      technology: "angular",
      title: "Components",
    },
  );
  expect(chunks).toHaveLength(1);
  expect(chunks[0].section).toBe("Change detection");
  expect(chunks[0].chunkText).toContain("Prefer OnPush");
  expect(chunks[0].chunkHash).toMatch(/^[a-f0-9]{64}$/);
});
```

Use a temp dir fixture (not only repo `knowledge-base/`) so tests stay hermetic.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @review/knowledge test -- discover.test.ts chunk.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `discoverDocuments` and `chunkMarkdown`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @review/knowledge test -- discover.test.ts chunk.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge
git commit -m "feat: discover and chunk knowledge-base Markdown"
```

---

### Task 4: Embedding providers and incremental ingest

**Files:**
- Create: `packages/knowledge/src/{embed,store,ingest}.ts`
- Test: `packages/knowledge/tests/embed.test.ts`, `packages/knowledge/tests/ingest.test.ts`
- Modify: `packages/knowledge/package.json` (deps: `@review/db`, `@review/shared`, `pg`)

**Interfaces:**
- Consumes: `DocumentChunkDraft`, `EmbeddingConfig`, `Pool`, `migrate`
- Produces:
  - `interface EmbeddingProvider { embed(texts: string[]): Promise<number[][]>; readonly dimensions: 768 }`
  - `createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider`
  - `FakeEmbeddingProvider`: deterministic bag-of-words → 768-dim L2-normalized vectors (shared tokens increase cosine similarity); used when `provider === "fake"`
  - `OpenAICompatibleEmbeddingProvider`: `POST {baseUrl}/embeddings` with body `{ model, input: string[] | string, dimensions: 768 }`; Authorization `Bearer ${apiKey}`; validate every vector length === 768 or throw `EmbeddingError`
  - `ingestKnowledgeBase(opts: { rootDir: string; pool: Pool; embedder: EmbeddingProvider }): Promise<IngestReport>`
  - `IngestReport`: `{ documentsSeen: number; chunksUpserted: number; chunksDeleted: number; documentsSkippedUnchanged: number }`
  - Algorithm:
    1. `discoverDocuments` → for each file read utf8 → `contentHash = sha256(fileBytes)`
    2. If all existing rows for `source_path` already have the same `content_hash`, skip (`documentsSkippedUnchanged++`)
    3. Else chunk → `embed(chunkTexts)` in batches of ≤64 → upsert by `chunk_hash` (UPDATE embedding/text/metadata/`content_hash`/`updated_at`)
    4. Delete rows for that `source_path` whose `chunk_hash` is not in the new set
    5. After all files: delete rows whose `source_path` is not in the discovered set (orphan cleanup for deleted files)
  - `store.ts` helpers: `upsertChunks`, `deleteChunksNotIn`, `deleteChunksForMissingPaths` — keep SQL here, not in ingest

- [ ] **Step 1: Write the failing tests**

```ts
// embed.test.ts
it("fake embedder is deterministic and 768-d", async () => {
  const p = createEmbeddingProvider({
    provider: "fake",
    model: "fake",
    dimensions: 768,
  });
  const [a] = await p.embed(["Prefer OnPush change detection"]);
  const [b] = await p.embed(["Prefer OnPush change detection"]);
  expect(a).toHaveLength(768);
  expect(a).toEqual(b);
});

// ingest.test.ts (DATABASE_URL required)
it("reingesting unchanged docs skips duplicates; deleting a file removes chunks", async () => {
  // temp KB with one md → ingest → count rows
  // ingest again → documentsSkippedUnchanged === 1, row count unchanged
  // delete file → ingest → row count 0 for that path
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @review/knowledge test -- embed.test.ts ingest.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement embed + store + ingest**

Batch embedding calls; on embedder throw, abort ingest and do not partially commit mid-file (per-file transaction is enough).

- [ ] **Step 4: Run tests to verify they pass**

Run: `DATABASE_URL=postgres://review:review@localhost:5433/review pnpm --filter @review/knowledge test -- embed.test.ts ingest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge
git commit -m "feat: embed and incrementally ingest document chunks"
```

---

### Task 5: Semantic retrieval with filters

**Files:**
- Create: `packages/knowledge/src/retrieve.ts`
- Test: `packages/knowledge/tests/retrieve.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider`, `Pool`, `CodingStandardRule`
- Produces:
  - `retrieveCodingStandards(opts: { pool: Pool; embedder: EmbeddingProvider; query: string; category?: DocumentCategory; technology?: DocumentTechnology; limit?: number }): Promise<CodingStandardRule[]>`
  - Default `limit` 5, max 10; empty/whitespace `query` → return `[]` (caller maps to `no_results`)
  - SQL: cosine distance `embedding <=> $1::vector` ascending; optional `AND category = $n` / `AND technology = $m`
  - Map rows → `CodingStandardRule` with `score = 1 / (1 + distance)` (or `1 - distance` if using cosine distance op that returns 0..2 — pick one formula and use it consistently in tests)
  - Truncate `ruleText` to **1500** characters per rule

- [ ] **Step 1: Write the failing test**

```ts
it("returns Angular OnPush rule for an Angular query and excludes it when technology=dotnet", async () => {
  // ingest fixture KB with fake embedder
  const angularHits = await retrieveCodingStandards({
    pool,
    embedder,
    query: "Angular component change detection OnPush",
    category: "coding-standards",
    technology: "angular",
    limit: 5,
  });
  expect(angularHits.some((r) => /OnPush/i.test(r.ruleText))).toBe(true);
  expect(angularHits.every((r) => r.technology === "angular")).toBe(true);

  const dotnetOnly = await retrieveCodingStandards({
    pool,
    embedder,
    query: "Angular component change detection OnPush",
    technology: "dotnet",
    limit: 5,
  });
  expect(dotnetOnly.every((r) => r.technology === "dotnet")).toBe(true);
  expect(dotnetOnly.some((r) => /OnPush/i.test(r.ruleText))).toBe(false);
});

it("returns empty array when index has no rows", async () => {
  const hits = await retrieveCodingStandards({
    pool: emptyPoolOrTruncatedTable,
    embedder,
    query: "anything",
  });
  expect(hits).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://review:review@localhost:5433/review pnpm --filter @review/knowledge test -- retrieve.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `retrieveCodingStandards`**

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://review:review@localhost:5433/review pnpm --filter @review/knowledge test -- retrieve.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge
git commit -m "feat: retrieve coding standards via pgvector"
```

---

### Task 6: Real `get_coding_standards` MCP tool, ingest CLI, smoke

**Files:**
- Create: `packages/knowledge/src/cli.ts`, `packages/mcp-server/src/tools/get_coding_standards.ts`, `packages/mcp-server/src/tools/router.ts`, `scripts/smoke-phase2.sh`
- Modify: `packages/mcp-server/src/tools/stubs.ts` (three stubs only), `packages/mcp-server/src/server.ts`, `packages/mcp-server/package.json` (deps `@review/knowledge`, `@review/db`, `@review/shared`), `packages/knowledge/package.json` (`bin` / script `ingest`), root `package.json` (`smoke:phase2`), `README.md`
- Test: `packages/mcp-server/tests/get_coding_standards.test.ts`; keep `tools.test.ts` green for remaining stubs

**Interfaces:**
- Consumes: `retrieveCodingStandards`, `createEmbeddingProvider`, `loadConfig`, `createPool`, `migrate`, `handleTool` stubs, `McpToolResult`
- Produces:
  - `getCodingStandardsInputSchema` (Zod): `{ query: string; category?: enum; technology?: enum; limit?: number }` — `query` required (min 1)
  - `handleGetCodingStandards(args, deps): Promise<McpToolResult>`
    - invalid args → `service_error` `{ code: "invalid_args", message }`
    - embed/db throw → `service_error` `{ code: "retrieval_failed", message }`
    - zero rules → `no_results` `{ rules: [] }`
    - else → `ok` `{ rules: CodingStandardRule[] }`
    - Bound payload: `JSON.stringify(result).length < 12_000`
  - Router: unknown tool → existing stub error; three Phase 1 tools → stubs; `get_coding_standards` → real handler
  - MCP `ListTools` description for standards tool mentions real retrieval; stubs still labeled stub
  - CLI: `pnpm --filter @review/knowledge ingest` → loadConfig(env) → migrate → createEmbeddingProvider → ingestKnowledgeBase → print `IngestReport` JSON to stdout; exit 1 on failure
  - Smoke: docker up → migrate → `EMBEDDING_PROVIDER=fake` ingest → run knowledge + mcp tests → print Phase 2 OK
  - README: Phase 2 section — KB layout, env vars, ingest command, note that only `get_coding_standards` is live

- [ ] **Step 1: Write the failing MCP test**

```ts
it("get_coding_standards returns ok rules after fake ingest", async () => {
  // migrate + ingest fixture with fake provider
  const result = await handleGetCodingStandards(
    { query: "Prefer OnPush change detection", technology: "angular", limit: 3 },
    deps,
  );
  expect(result.status).toBe("ok");
  expect(result.data.rules[0].documentPath).toMatch(/components\.md$/);
  expect(result.data.rules[0].section.length).toBeGreaterThan(0);
});

it("get_coding_standards returns no_results for empty index", async () => {
  const result = await handleGetCodingStandards({ query: "anything" }, emptyDeps);
  expect(result.status).toBe("no_results");
});

it("get_coding_standards returns service_error when embedder throws", async () => {
  const result = await handleGetCodingStandards({ query: "x" }, explodingDeps);
  expect(result.status).toBe("service_error");
  expect(result.error?.code).toBe("retrieval_failed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=… EMBEDDING_PROVIDER=fake pnpm --filter @review/mcp-server test -- get_coding_standards.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement router, real tool, CLI, smoke script, README**

MCP server process loads config from env at startup (or lazy on first standards call). Do not require embedding API key when `EMBEDDING_PROVIDER=fake`.

- [ ] **Step 4: Run tests and smoke**

Run:
```bash
pnpm test
EMBEDDING_PROVIDER=fake ./scripts/smoke-phase2.sh
```
Expected: all PASS; smoke prints `Phase 2 smoke OK`

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge packages/mcp-server scripts/smoke-phase2.sh package.json README.md
git commit -m "feat: wire get_coding_standards RAG and Phase 2 smoke"
```

---

## Self-Review

1. **Spec coverage:** §5.5 discovery/chunk/embed/store/incremental/retrieve → Tasks 3–5; `get_coding_standards` → Task 6; KB structure → Task 1; pgvector store → Task 2; §9 Document RAG acceptance → Tasks 4–6 tests; Phase 2 §10 bullets all mapped. Code intelligence / other MCP tools / Teams explicitly out of scope.
2. **Step scan:** Steps pin signatures, env names, dimensions (768), limits (5/10, 1200/1500 chars), status codes, and SQL uniqueness — no TBD bodies.
3. **Type consistency:** `CodingStandardRule`, `DocumentCategory`, `DocumentTechnology`, `McpToolResult`, `EmbeddingProvider.embed(texts) → number[][]`, `IngestReport` used consistently across tasks.
4. **Review Focus:** orphan delete → Task 4 ingest test; unchanged skip → Task 4; embed failure → Task 6 service_error test; technology filter → Task 5; empty index → Tasks 5–6.
5. **Proportion:** Plan decides interfaces and pinned values; chunk/embed algorithms left to implementers within stated constraints.
