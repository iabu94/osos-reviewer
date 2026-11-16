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

## Packages

| Package | Role |
|---------|------|
| `@review/shared` | Config + shared types/errors |
| `@review/db` | Postgres pool, migrate, health |
| `@review/git-manager` | Ticket/companion, worktrees, focused diff |
| `@review/mcp-server` | Four stub MCP tools over stdio |
| `@review/orchestrator` | Review lifecycle + CLI |

## Spec & plan

- Spec: `docs/superpowers/specs/2026-11-16-review-orchestrator-prd.md`
- Phase 1 plan: `docs/superpowers/plans/2026-11-16-phase1-foundation.md`
