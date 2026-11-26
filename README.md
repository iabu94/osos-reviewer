# OSOS Reviewer

Teams-triggered, token-efficient cross-repository code review orchestrator (Centroniz). A Microsoft Teams mention with a GitHub PR URL runs a focused review across backend (.NET) and frontend (Angular) repos via Claude Code, MCP tools, Postgres/pgvector indexes, and Adaptive Card replies.

Phases 1–6 are implemented: foundation, document RAG, code intelligence, MCP review tools, structured Claude review, and Teams webhook delivery.

## Architecture

```text
Microsoft Teams (ReviewBot mention + PR URL)
      |
      v
Nest HTTP host (@osos-reviewer/api)  --HMAC-->  202 accepted
      |  (handlers from @osos-reviewer/teams)
      v
Review worker (@osos-reviewer/orchestrator)
      |
      +-- resolve PR branches (GitHub API)
      +-- Git worktrees + focused diff (@osos-reviewer/git-manager)
      +-- PR delta code index (@osos-reviewer/code-intel)
      +-- Claude Code headless (claude -p, structured JSON)
      |         |
      |         v
      |   MCP tools (@osos-reviewer/mcp-server)
      |     trace_fe_be_integration
      |     trace_symbol_impact
      |     check_reusability
      |     get_coding_standards  <-- knowledge RAG (@osos-reviewer/knowledge)
      |
      +-- Adaptive Card reply to Teams thread
      +-- PostgreSQL + pgvector (@osos-reviewer/db)
```

Local CLI reviews skip Teams and call the same `runReview` path directly. `npm start` boots the Nest Teams app (`@osos-reviewer/api`).

## Prerequisites

- Node.js 22+
- npm 10+
- Docker (Postgres, Ollama/EmbeddingGemma; optional ngrok tunnel)
- Claude Code CLI (`claude`) on the **host** for live reviews — use Claude Pro via `claude auth login` (do **not** set `ANTHROPIC_API_KEY`)
- For smoke without embeddings: `EMBEDDING_PROVIDER=fake`

## Setup (hybrid: Docker deps + local API)

The Nest API, orchestrator, git worktrees, and Claude Code run on the host. Docker provides Postgres, Ollama (EmbeddingGemma), and optionally ngrok.

```bash
npm install
cp .env.example .env   # edit REPOS_JSON / paths; REPOS_JSON is single-quoted JSON
# Set NGROK_AUTHTOKEN in .env if you will use the tunnel profile
docker compose up -d                  # db + ollama; pulls embeddinggemma via ollama-init
docker compose --profile tunnel up -d # also starts ngrok → host :3080 (needs NGROK_AUTHTOKEN)
claude auth login                     # once, Claude Pro on this machine
npm start                             # Nest Teams app on :3080
```

The Nest Teams app and orchestrator CLI load `.env` via `tsx --env-file=../../.env`. Knowledge ingest and code-intel `index-baseline` load the repo-root `.env` via `dotenv`.

| Service | Host port | Notes |
|---------|-----------|--------|
| Postgres (`db`) | **5433** | Avoids clashing with a local Postgres on 5432 |
| Ollama | **11434** | OpenAI-compatible base `http://localhost:11434/v1`, model `embeddinggemma` (768-d) |
| ngrok | **4040** (inspector) | Fixed HTTPS: `https://primarily-live-stag.ngrok-free.app` → host `:3080`. Point Teams at `…/teams-hook` |
| Nest API | **3080** | Local only; ngrok uses `host.docker.internal:3080` (Docker Desktop / `host-gateway`) |

Create the test database when running DB-backed suites:

```bash
docker compose exec db psql -U review -c 'CREATE DATABASE review_test;'
export TEST_DATABASE_URL=postgres://review:review@localhost:5433/review_test
```

Smoke embeddings against Ollama:

```bash
curl -s http://localhost:11434/v1/embeddings \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer ollama' \
  -d '{"model":"embeddinggemma","input":"hello","dimensions":768}'
```

## Environment

| Variable | Default / notes |
|----------|-----------------|
| `DATABASE_URL` | required — e.g. `postgres://review:review@localhost:5433/review` |
| `TEST_DATABASE_URL` | tests only; must differ from `DATABASE_URL` (suites truncate tables) |
| `WORKTREE_ROOT` | required — worktree parent directory |
| `REPOS_JSON` | required — single-quoted JSON array of repo configs (`id`, `role`, `localPath`, `defaultBaseBranch`, optional `githubRepo`) |
| `CLAUDE_CLI_PATH` | `claude` — host binary; authenticate with Pro (`claude auth login`), leave `ANTHROPIC_API_KEY` unset |
| `COMPANION_FALLBACK_BRANCH` | `origin/develop` |
| `REVIEW_TIMEOUT_MS` | `120000` |
| `REQUIRE_DB` | `false` — set `true` for PR delta indexing during reviews |
| `KNOWLEDGE_BASE_PATH` | `knowledge-base` (relative to repo root) |
| `EMBEDDING_PROVIDER` | `openai_compatible` or `fake` |
| `EMBEDDING_BASE_URL` | `http://localhost:11434/v1` (Ollama in Compose); or any OpenAI-compatible base |
| `EMBEDDING_API_KEY` | required unless provider is `fake` — use `ollama` for local Ollama (ignored by server) |
| `EMBEDDING_MODEL` | `embeddinggemma` (768-d) when using Compose Ollama |
| `REQUIRE_TEAMS` | `false` — `start:teams` forces `true` |
| `TEAMS_WEBHOOK_SECRET` | HMAC secret for inbound webhooks (quote if it contains `=`) |
| `TEAMS_REPLY_FLOW_URL` | Power Automate HTTP URL for Adaptive Card replies (Teams App path) |
| `TEAMS_BOT_APP_ID` / `TEAMS_BOT_PASSWORD` | Bot Connector OAuth alternative (unused when flow URL is set) |
| `TEAMS_WEBHOOK_PORT` | `3080` |
| `GITHUB_TOKEN` | resolves PR head/base via GitHub API (required for Teams path) |
| `MAX_CONCURRENT_REVIEWS` | `2` |
| `REVIEW_RETRY_MAX` | `2` |
| `NGROK_AUTHTOKEN` | required only for `docker compose --profile tunnel` |
| `NGROK_DOMAIN` | reserved hostname (default `primarily-live-stag.ngrok-free.app`) |

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
npm run start -w @osos-reviewer/orchestrator -- \
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
npm run ingest -w @osos-reviewer/knowledge
```

- Unchanged documents are skipped only when both file content and embedding model match; changing `EMBEDDING_PROVIDER`/`EMBEDDING_MODEL` re-embeds everything.
- If discovery finds zero documents, ingest refuses to delete the existing index. Pass `--force-empty` to clear it intentionally.
- Markdown under unknown top-level folders is skipped with a warning on stderr.

## Code intelligence

`@osos-reviewer/code-intel` indexes symbols and relationships into Postgres (`code_symbols` plus relationship rows, pgvector embeddings).

**Parsers**

- **.NET (`.cs`)**: `tree-sitter` + `tree-sitter-c-sharp` (controllers, services, DTOs, DbContext, validators).
- **Angular (`.ts`)**: TypeScript compiler API (components, services, interfaces/models).

**Baseline index** (default branch; `index_scope = 'baseline'`):

```bash
npm run index-baseline -w @osos-reviewer/code-intel -- --repo-id be
npm run index-baseline -w @osos-reviewer/code-intel -- --repo-id fe
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
npm start
# or: npm run start:teams -w @osos-reviewer/api
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
- **Label** `ai-review:completed` is applied to the PR after a successful (`completed`) review delivery (including idempotent skip retries). Failed reviews are not labeled.
- Local CLI `runReview` does **not** post to GitHub; only the Teams worker path does.
- Set `GITHUB_REVIEW_DELIVERY=false` to keep Teams-only delivery.

## Packages

| Package | Role |
|---------|------|
| `@osos-reviewer/shared` | Config + shared types/errors |
| `@osos-reviewer/db` | Postgres pool, migrate, health, reviews lifecycle |
| `@osos-reviewer/git-manager` | Ticket/companion, worktrees, focused diff |
| `@osos-reviewer/code-intel` | Symbol parsing, baseline + PR delta indexing, retrieval |
| `@osos-reviewer/knowledge` | Knowledge-base discovery, chunking, embeddings, ingest, retrieval |
| `@osos-reviewer/mcp-server` | MCP tools over stdio |
| `@osos-reviewer/orchestrator` | Review lifecycle, CLI review, Teams runtime/worker |
| `@osos-reviewer/teams` | Webhook handler, Adaptive Cards, Bot Connector client |
| `@osos-reviewer/api` | NestJS HTTP host for Teams webhook (`npm start`) |

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
