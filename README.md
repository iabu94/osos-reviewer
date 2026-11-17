# Cursor Review Platform

Teams-triggered, token-efficient cross-repository code review orchestrator (Centroniz). Phase 1 delivers the local foundation: config, Postgres/pgvector, Git worktrees, MCP stubs, and Claude Code headless invocation.

## Phase 1 architecture

```text
CLI / local trigger
      |
      v
Orchestrator (@review/orchestrator)
      |
      +-- parse PR URL + ticket id
      +-- Git worktrees + focused diff (@review/git-manager)
      +-- Claude Code headless (claude -p)
      |         |
      |         v
      |   MCP server stubs (@review/mcp-server)
      |
      +-- PostgreSQL + pgvector health (@review/db)
```

Later phases add document RAG, AST code intelligence, real MCP tools, and Microsoft Teams.

## Prerequisites

- Node.js 22+
- pnpm 9+
- Docker (for Postgres)
- Optional: Claude Code CLI (`claude`) for live reviews

## Setup

```bash
pnpm install
cp .env.example .env   # edit REPOS_JSON / paths; REPOS_JSON is single-quoted JSON
docker compose up -d
```

The orchestrator CLI loads `.env` via `tsx --env-file=../../.env`. Postgres is published on **host port 5433** (avoids clashing with a local Postgres on 5432).

## Test

```bash
pnpm test
# or
./scripts/smoke-phase1.sh
```

## Local review (Phase 1)

Configure `REPOS_JSON` with local clones and `githubRepo` values matching the PR host/owner/repo. Branch resolution is manual until GitHub API wiring:

```bash
pnpm --filter @review/orchestrator start -- \
  --pr-url https://github.com/acme/backend/pull/1 \
  --primary-branch feature/ABC-123 \
  --target-branch develop
```

## Phase 2: Document RAG

Coding standards, architecture, and security docs are ingested into Postgres (pgvector) and served by the `get_coding_standards` MCP tool.

**Knowledge base layout** (`knowledge-base/`, Markdown only):

```text
knowledge-base/
  coding-standards/<technology>/*.md   # angular, dotnet, database, general
  architecture/...
  security/...
```

Category comes from the top-level folder and technology from the sub-folder.

**Environment variables**

| Variable | Default | Notes |
|----------|---------|-------|
| `DATABASE_URL` | required | e.g. `postgres://review:review@localhost:5433/review` |
| `KNOWLEDGE_BASE_PATH` | `knowledge-base` | Absolute, or relative to the repository root (never the current directory) |
| `TEST_DATABASE_URL` | unset | Tests only; e.g. `postgres://review:review@localhost:5433/review_test`. DB tests are skipped without it and refuse to run against `DATABASE_URL` |
| `EMBEDDING_PROVIDER` | `openai_compatible` | `fake` for tests/smoke (no API key needed) |
| `EMBEDDING_BASE_URL` | `https://api.openai.com/v1` | |
| `EMBEDDING_API_KEY` | | Required unless provider is `fake` |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Vectors are 768-dimensional; stored per chunk as `provider:model` |

**Ingest** (migrates, embeds, upserts changed docs, removes deleted ones, prints an `IngestReport` JSON):

```bash
pnpm --filter @review/knowledge ingest
```

- Unchanged documents are skipped only when both file content and embedding model match; changing `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL` re-embeds everything, and retrieval only returns chunks from the current model.
- If discovery finds zero documents, ingest refuses to delete the existing index. Pass `--force-empty` (`pnpm --filter @review/knowledge ingest --force-empty`) to clear it intentionally.
- Markdown under unknown top-level folders is skipped with a warning on stderr.

**Tests:** DB-backed suites truncate tables, so they use a separate database (`TEST_DATABASE_URL`, created on demand) and never touch the real index:

```bash
export TEST_DATABASE_URL=postgres://review:review@localhost:5433/review_test
pnpm test
```

**Smoke test:** `pnpm smoke:phase2` (or `EMBEDDING_PROVIDER=fake ./scripts/smoke-phase2.sh`). It runs tests against `review_test`, then ingests into the real `DATABASE_URL` so the index is left populated.

See **Phase 4** below for the code-intelligence MCP tools. The MCP server lazily initializes Postgres and the embedder from env on the first tool call.

## Phase 3: Code intelligence

`@review/code-intel` indexes code symbols and relationships into Postgres (`code_symbols` plus relationship rows, pgvector embeddings) so later phases can answer cross-repo questions without re-reading whole trees.

**Parsers**

- **.NET backend (`.cs`)**: `tree-sitter` + `tree-sitter-c-sharp` (controllers, services, DTOs, DbContext, validators).
- **Angular frontend (`.ts`)**: the TypeScript compiler API (components, services, interfaces/models).

**Baseline index** (default branch; `index_scope = 'baseline'`). Unchanged files (by content hash) are skipped, stale symbols are replaced, and deleted files are removed:

```bash
pnpm --filter @review/code-intel index-baseline --repo-id be
pnpm --filter @review/code-intel index-baseline --repo-id fe
```

**Delta on review.** When `REQUIRE_DB=true`, `runReview` indexes only the files changed on each PR branch (primary and companion worktrees) as `index_scope = 'pr'` rows tagged with the `reviewId`, after the focused diff and before Claude runs. Baseline rows are never modified. PR rows are always deleted in the lifecycle `finally` (even when Claude or indexing fails). An indexing error fails the review with `error.code = "index_failed"`.

**Smoke test:** `pnpm smoke:phase3` (or `EMBEDDING_PROVIDER=fake ./scripts/smoke-phase3.sh`) runs the code-intel, git-manager, and orchestrator tests, then baseline-indexes the fixture trees into the test database.

## Phase 4: MCP review tools

All four MCP tools are live. They read the same Postgres code index and knowledge base as Phase 2–3, with structured JSON results bounded under 12 000 characters.

| Tool | Purpose |
|------|---------|
| `trace_fe_be_integration` | Cross-repo FE/BE contract mismatches |
| `trace_symbol_impact` | Relationship impact from a seed symbol |
| `check_reusability` | Similar-symbol candidates for reuse review |
| `get_coding_standards` | Document RAG (unchanged from Phase 2) |

**Example MCP arguments**

```json
{ "backendRepoIds": ["be"], "frontendRepoIds": ["fe"] }
```

```json
{ "symbolName": "OrdersController", "repoIds": ["be"], "maxDepth": 2 }
```

```json
{ "query": "list orders from api", "repoIds": ["be"], "limit": 5 }
```

`check_reusability` explanations use **candidate** wording — they are hints for human review, not proof of duplication. When any embeddings exist in the searched scope, the vector path is preferred and name-only matches for symbols without embeddings may not appear (Task 4 retrieval behavior).

**Smoke test:** `pnpm smoke:phase4` (or `EMBEDDING_PROVIDER=fake ./scripts/smoke-phase4.sh`) indexes happy-path and deliberate-mismatch fixtures into `TEST_DATABASE_URL`, then runs `@review/code-intel` and `@review/mcp-server` tests.

## Phase 5 — Claude structured review

The orchestrator builds a structured review prompt (`buildReviewPrompt`), invokes Claude Code in headless mode with `--permission-mode dontAsk`, JSON output, and `REVIEW_OUTPUT_JSON_SCHEMA` for structured findings, then validates stdout via `parseClaudeReviewOutput`. Successful runs attach `report` and token/duration `diagnostics` on `ReviewResult`; the CLI prints the full JSON payload.

Allowed tools include read-only `Read` plus the four `mcp__review__*` MCP tools; edit/write/bash tools stay disallowed.

Teams Adaptive Card delivery is deferred to Phase 6. If a real `claude` binary is on `PATH`, Phase 5 smoke still only runs unit tests (no live invoke / billing).

**Smoke test:** `pnpm smoke:phase5` (or `./scripts/smoke-phase5.sh`) runs `@review/orchestrator` tests with fake Claude fixtures.

## Phase 6 — Microsoft Teams webhook

Teams messages that mention **ReviewBot** and include a GitHub pull request URL trigger an asynchronous review. The HTTP server (`@review/teams`) exposes:

| Route | Response |
|-------|-----------|
| `POST /hooks/teams` | `202` `{ reviewId, duplicated, status: "accepted" }` after enqueue |
| `GET /healthz` | `200` `{ ok: true }` |

**Authentication:** POST bodies are authenticated with HMAC-SHA256 in the `x-review-signature` header (`sha256=<hex>` of the raw body, keyed by `TEAMS_WEBHOOK_SECRET`). Invalid signatures return `401` `{ error: "unauthorized" }`. Parse/validation failures return `400` with `error` (code) and `message`. This is a lightweight shared-secret check — not full Microsoft Bot Framework JWT validation (a future hardening step).

**Environment (set `REQUIRE_TEAMS=true` for `pnpm --filter @review/teams start`):**

| Variable | Role |
|----------|------|
| `TEAMS_WEBHOOK_SECRET` | HMAC secret for inbound webhooks |
| `TEAMS_BOT_APP_ID` / `TEAMS_BOT_PASSWORD` | Bot Connector OAuth for Adaptive Card replies |
| `TEAMS_WEBHOOK_PORT` | Listen port (default `3080`) |
| `GITHUB_TOKEN` | Resolves PR head/base branches via GitHub API |
| `MAX_CONCURRENT_REVIEWS` | Worker concurrency (default `2`) |
| `REVIEW_RETRY_MAX` | Retries for retryable failures (e.g. Teams delivery) |

**Behavior:** The webhook returns **202 immediately**; the in-process worker runs `runReview`, builds an Adaptive Card (completed summary/findings, failed state, or `NO_FINDINGS_SUMMARY`), and posts it to the originating thread via Bot Connector. **Idempotency** uses Teams activity id or a hash of conversation + PR URL (`reviews.idempotency_key`); duplicate terminal reviews return `duplicated: true` without re-running. **Concurrency** is enforced in the worker with a semaphore (`MAX_CONCURRENT_REVIEWS`).

**Smoke / bench:** `pnpm smoke:phase6` runs package tests plus a signed fixture POST to an ephemeral server (prints `Phase 6 smoke OK`). `pnpm bench:phase6` runs one worker job with a fake `runReview` (diagnostics only) and writes `bench-phase6-out.json` (exits `0`; warns if wall clock > 30s).

## Packages

| Package | Role |
|---------|------|
| `@review/shared` | Config + shared types/errors |
| `@review/db` | Postgres pool, migrate, health |
| `@review/git-manager` | Ticket/companion, worktrees, focused diff |
| `@review/code-intel` | Tree-sitter/TypeScript symbol parsing, baseline + PR delta indexing, retrieval |
| `@review/knowledge` | Knowledge-base discovery, chunking, embeddings, ingest, retrieval |
| `@review/mcp-server` | MCP tools over stdio: integration, impact, reusability, and coding standards |
| `@review/orchestrator` | Review lifecycle + CLI |
| `@review/teams` | Teams webhook, Adaptive Cards, Bot Connector client |

## Spec & plan

- Spec: `docs/superpowers/specs/2026-11-16-review-orchestrator-prd.md`
- Phase 1 plan: `docs/superpowers/plans/2026-11-16-phase1-foundation.md`
- Phase 3 plan: `docs/superpowers/plans/2026-11-17-phase3-code-intelligence.md`
