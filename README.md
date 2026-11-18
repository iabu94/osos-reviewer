# Cursor Review Platform

Teams-triggered, token-efficient cross-repository code review orchestrator (Centroniz). A Microsoft Teams mention with a GitHub PR URL runs a focused review across backend (.NET) and frontend (Angular) repos via Claude Code, MCP tools, Postgres/pgvector indexes, and Adaptive Card replies.

Phases 1–6 are implemented: foundation, document RAG, code intelligence, MCP review tools, structured Claude review, and Teams webhook delivery.

## Architecture

```text
Microsoft Teams (ReviewBot mention + PR URL)
      |
      v
Teams webhook (@review/teams)  --HMAC-->  202 accepted
      |
      v
Review worker (@review/orchestrator)
      |
      +-- resolve PR branches (GitHub API)
      +-- Git worktrees + focused diff (@review/git-manager)
      +-- PR delta code index (@review/code-intel)
      +-- Claude Code headless (claude -p, structured JSON)
      |         |
      |         v
      |   MCP tools (@review/mcp-server)
      |     trace_fe_be_integration
      |     trace_symbol_impact
      |     check_reusability
      |     get_coding_standards  <-- knowledge RAG (@review/knowledge)
      |
      +-- Adaptive Card reply to Teams thread
      +-- PostgreSQL + pgvector (@review/db)
```

Local CLI reviews skip Teams and call the same `runReview` path directly.

## Prerequisites

- Node.js 22+
- npm 10+
- Docker (for Postgres)
- Optional: Claude Code CLI (`claude`) for live reviews
- Optional: OpenAI-compatible embeddings API for real RAG/code vectors (`EMBEDDING_PROVIDER=fake` for local smoke)

## Setup

```bash
npm install
cp .env.example .env   # edit REPOS_JSON / paths; REPOS_JSON is single-quoted JSON
docker compose up -d
```

The orchestrator CLI loads `.env` via `tsx --env-file=../../.env`. Postgres is published on **host port 5433** (avoids clashing with a local Postgres on 5432).

Create the test database when running DB-backed suites:

```bash
docker compose exec db psql -U review -c 'CREATE DATABASE review_test;'
export TEST_DATABASE_URL=postgres://review:review@localhost:5433/review_test
```

## Environment

| Variable | Default / notes |
|----------|-----------------|
| `DATABASE_URL` | required — e.g. `postgres://review:review@localhost:5433/review` |
| `TEST_DATABASE_URL` | tests only; must differ from `DATABASE_URL` (suites truncate tables) |
| `WORKTREE_ROOT` | required — worktree parent directory |
| `REPOS_JSON` | required — single-quoted JSON array of repo configs (`id`, `role`, `localPath`, `defaultBaseBranch`, optional `githubRepo`) |
| `CLAUDE_CLI_PATH` | `claude` |
| `COMPANION_FALLBACK_BRANCH` | `origin/develop` |
| `REVIEW_TIMEOUT_MS` | `120000` |
| `REQUIRE_DB` | `false` — set `true` for PR delta indexing during reviews |
| `KNOWLEDGE_BASE_PATH` | `knowledge-base` (relative to repo root) |
| `EMBEDDING_PROVIDER` | `openai_compatible` or `fake` |
| `EMBEDDING_BASE_URL` | `https://api.openai.com/v1` |
| `EMBEDDING_API_KEY` | required unless provider is `fake` |
| `EMBEDDING_MODEL` | `text-embedding-3-small` (768-d vectors) |
| `REQUIRE_TEAMS` | `false` — `start:teams` forces `true` |
| `TEAMS_WEBHOOK_SECRET` | HMAC secret for inbound webhooks (quote if it contains `=`) |
| `TEAMS_REPLY_FLOW_URL` | Power Automate HTTP URL for Adaptive Card replies (Teams App path) |
| `TEAMS_BOT_APP_ID` / `TEAMS_BOT_PASSWORD` | Bot Connector OAuth alternative (unused when flow URL is set) |
| `TEAMS_WEBHOOK_PORT` | `3080` |
| `GITHUB_TOKEN` | resolves PR head/base via GitHub API (required for Teams path) |
| `MAX_CONCURRENT_REVIEWS` | `2` |
| `REVIEW_RETRY_MAX` | `2` |

## Test & smoke

```bash
npm test
npm run smoke:phase1   # foundation
npm run smoke:phase2   # document RAG (fake embeddings OK)
npm run smoke:phase3   # code intelligence
npm run smoke:phase4   # MCP tools
npm run smoke:phase5   # Claude structured review (unit fixtures only)
npm run smoke:phase6   # Teams webhook + Adaptive Card path
npm run bench:phase6   # worker timing with fake runReview → bench-phase6-out.json
```

## Local CLI review

Configure `REPOS_JSON` with local clones and `githubRepo` values matching the PR host/owner/repo. For CLI-only runs without GitHub API, pass branches explicitly:

```bash
npm run start -w @review/orchestrator -- \
  --pr-url https://github.com/acme/backend/pull/1 \
  --primary-branch feature/ABC-123 \
  --target-branch develop
```

With `REQUIRE_DB=true`, the review indexes changed files as `index_scope = 'pr'` rows tagged with the `reviewId` (baseline rows are never modified). PR rows are always deleted in the lifecycle `finally`.

## Document RAG

Coding standards, architecture, and security docs are ingested into Postgres (pgvector) and served by `get_coding_standards`.

**Knowledge base layout** (`knowledge-base/`, Markdown only):

```text
knowledge-base/
  coding-standards/<technology>/*.md   # angular, dotnet, database, general
  architecture/...
  security/...
```

Category comes from the top-level folder and technology from the sub-folder.

```bash
npm run ingest -w @review/knowledge
```

- Unchanged documents are skipped only when both file content and embedding model match; changing `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL` re-embeds everything.
- If discovery finds zero documents, ingest refuses to delete the existing index. Pass `--force-empty` to clear it intentionally.
- Markdown under unknown top-level folders is skipped with a warning on stderr.

## Code intelligence

`@review/code-intel` indexes symbols and relationships into Postgres (`code_symbols` plus relationship rows, pgvector embeddings).

**Parsers**

- **.NET (`.cs`)**: `tree-sitter` + `tree-sitter-c-sharp` (controllers, services, DTOs, DbContext, validators).
- **Angular (`.ts`)**: TypeScript compiler API (components, services, interfaces/models).

**Baseline index** (default branch; `index_scope = 'baseline'`):

```bash
npm run index-baseline -w @review/code-intel -- --repo-id be
npm run index-baseline -w @review/code-intel -- --repo-id fe
```

Unchanged files (by content hash) are skipped; stale symbols are replaced; deleted files are removed. An indexing error during review fails with `error.code = "index_failed"`.

## MCP review tools

All four MCP tools are live. They read the same Postgres code index and knowledge base, with structured JSON results bounded under 12 000 characters.

| Tool | Purpose |
|------|---------|
| `trace_fe_be_integration` | Cross-repo FE/BE contract mismatches |
| `trace_symbol_impact` | Relationship impact from a seed symbol |
| `check_reusability` | Similar-symbol candidates for reuse review |
| `get_coding_standards` | Document RAG |

**Example arguments**

```json
{ "backendRepoIds": ["be"], "frontendRepoIds": ["fe"] }
```

```json
{ "symbolName": "OrdersController", "repoIds": ["be"], "maxDepth": 2 }
```

```json
{ "query": "list orders from api", "repoIds": ["be"], "limit": 5 }
```

`check_reusability` explanations use **candidate** wording — hints for human review, not proof of duplication. The MCP server lazily initializes Postgres and the embedder from env on the first tool call.

## Claude structured review

The orchestrator builds a structured review prompt (`buildReviewPrompt`), invokes Claude Code headless with `--permission-mode dontAsk`, JSON output, and `REVIEW_OUTPUT_JSON_SCHEMA`, then validates stdout via `parseClaudeReviewOutput`. Successful runs attach `report` and token/duration `diagnostics` on `ReviewResult`; the CLI prints the full JSON payload.

Allowed tools include read-only `Read` plus the four `mcp__review__*` MCP tools; edit/write/bash tools stay disallowed. Phase 5 smoke only runs unit tests (no live invoke / billing).

## Microsoft Teams webhook

Teams messages that mention **ReviewBot** and include a GitHub pull request URL trigger an asynchronous review.

```bash
npm run start:teams -w @review/orchestrator
```

| Route | Response |
|-------|-----------|
| `POST /teams-hook` | Teams Outgoing Webhook: `Authorization: HMAC …` → `200` message ack; or `x-review-signature: sha256=…` → `202` `{ reviewId, duplicated, status: "accepted" }` |
| `GET /healthz` | `200` `{ ok: true }` |

**Authentication:** POST bodies use HMAC-SHA256 in `x-review-signature` (`sha256=<hex>` of the raw body, keyed by `TEAMS_WEBHOOK_SECRET`). Invalid signatures return `401`. Parse/validation failures return `400` with `error` and `message`. This is a shared-secret check — not full Microsoft Bot Framework JWT validation (future hardening).

**Behavior:** The webhook returns **202 immediately**; the in-process worker runs `runReview`, builds a compact Adaptive Card (`AI review of owner/repo#n`, PR title, Head / Status / Findings, **Open GitHub review**), and posts it to the originating thread via **Power Automate** (`TEAMS_REPLY_FLOW_URL`) or Bot Connector when bot credentials are set. Detailed findings are posted on the GitHub PR when delivery is enabled. The flow receives JSON with `serviceUrl`, `conversationId`, `activityId`, `replyToId`, `contentType`, and `card`. **Idempotency** uses Teams activity id or a hash of conversation + PR URL (`reviews.idempotency_key`); duplicate terminal reviews return `duplicated: true` without re-running. **Concurrency** is enforced with a semaphore (`MAX_CONCURRENT_REVIEWS`).

## GitHub PR review delivery

When `GITHUB_TOKEN` is set and `GITHUB_REVIEW_DELIVERY` is not `false`, the Teams worker also posts a GitHub **`COMMENT`** pull-request review to the trigger PR (never `APPROVE` / `REQUEST_CHANGES`). Delivery order is GitHub then Teams.

- **Summary body** includes the review summary (or exact `NO_FINDINGS_SUMMARY` / failure code) plus an HTML marker `<!-- review-orchestrator:reviewId=… -->` used for idempotent skip on retries.
- **Inline comments** (max 20) only for findings whose path is on the PR files list, with a positive `lineStart`, and whose `repo` matches the trigger PR (`owner/repo` or bare `repo`) or is omitted. Cross-repo / missing-line findings stay in the review body only.
- Local CLI `runReview` does **not** post to GitHub; only the Teams worker path does.
- Set `GITHUB_REVIEW_DELIVERY=false` to keep Teams-only delivery.

## Packages

| Package | Role |
|---------|------|
| `@review/shared` | Config + shared types/errors |
| `@review/db` | Postgres pool, migrate, health, reviews lifecycle |
| `@review/git-manager` | Ticket/companion, worktrees, focused diff |
| `@review/code-intel` | Symbol parsing, baseline + PR delta indexing, retrieval |
| `@review/knowledge` | Knowledge-base discovery, chunking, embeddings, ingest, retrieval |
| `@review/mcp-server` | MCP tools over stdio |
| `@review/orchestrator` | Review lifecycle, CLI, Teams worker + `start:teams` |
| `@review/teams` | Webhook server, Adaptive Cards, Bot Connector client |

## Spec & plans

- Spec: `docs/superpowers/specs/2026-11-16-review-orchestrator-prd.md`
- GitHub delivery design: `docs/superpowers/specs/2026-11-18-github-review-delivery-design.md`
- Product brief: `refs/PRD.md`
- Phase 1: `docs/superpowers/plans/2026-11-16-phase1-foundation.md`
- Phase 2: `docs/superpowers/plans/2026-11-17-phase2-document-rag.md`
- Phase 3: `docs/superpowers/plans/2026-11-17-phase3-code-intelligence.md`
- Phase 4: `docs/superpowers/plans/2026-11-17-phase4-mcp-review-capabilities.md`
- Phase 5: `docs/superpowers/plans/2026-11-17-phase5-claude-code-review.md`
- Phase 6: `docs/superpowers/plans/2026-11-17-phase6-teams-integration.md`
- Phase 7: `docs/superpowers/plans/2026-11-18-phase7-github-review-delivery.md`
