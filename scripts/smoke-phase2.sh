#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DATABASE_URL="${DATABASE_URL:-postgres://review:review@localhost:5433/review}"
# Always fake: never call a real embedding API from smoke.
export EMBEDDING_PROVIDER=fake

pg_ready() {
  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -d "$DATABASE_URL" >/dev/null 2>&1
  elif command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" -c 'select 1' >/dev/null 2>&1
  else
    docker compose exec -T db pg_isready -U review -d review >/dev/null 2>&1
  fi
}

echo "==> Starting Postgres (pgvector on host port 5433)"
if ! docker compose up -d; then
  # e.g. port 5433 already allocated by an existing container
  echo "    docker compose up failed; checking for an existing Postgres via DATABASE_URL"
fi
for _ in $(seq 1 30); do
  if pg_ready; then
    break
  fi
  sleep 1
done
if ! pg_ready; then
  echo "Postgres is not reachable via DATABASE_URL" >&2
  exit 1
fi

echo "==> Migrating and ingesting knowledge base (EMBEDDING_PROVIDER=$EMBEDDING_PROVIDER)"
pnpm --filter @review/knowledge ingest

echo "==> Running knowledge + MCP server tests"
pnpm --filter @review/knowledge test
pnpm --filter @review/mcp-server test

echo "Phase 2 smoke OK"
