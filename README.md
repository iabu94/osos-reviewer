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

Only `get_coding_standards` is live. `trace_fe_be_integration`, `trace_symbol_impact`, and `check_reusability` remain Phase 1 stubs. The MCP server reads the same env vars lazily on the first standards call.

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

The MCP tools `trace_fe_be_integration`, `trace_symbol_impact`, and `check_reusability` are **still stubs**; consuming the index from MCP is Phase 4.

## Packages

| Package | Role |
|---------|------|
| `@review/shared` | Config + shared types/errors |
| `@review/db` | Postgres pool, migrate, health |
| `@review/git-manager` | Ticket/companion, worktrees, focused diff |
| `@review/code-intel` | Tree-sitter/TypeScript symbol parsing, baseline + PR delta indexing, retrieval |
| `@review/knowledge` | Knowledge-base discovery, chunking, embeddings, ingest, retrieval |
| `@review/mcp-server` | MCP tools over stdio: live `get_coding_standards` + three Phase 1 stubs |
| `@review/orchestrator` | Review lifecycle + CLI |

## Spec & plan

- Spec: `docs/superpowers/specs/2026-11-16-review-orchestrator-prd.md`
- Phase 1 plan: `docs/superpowers/plans/2026-11-16-phase1-foundation.md`
- Phase 3 plan: `docs/superpowers/plans/2026-11-17-phase3-code-intelligence.md`
