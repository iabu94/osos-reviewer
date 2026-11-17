#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DATABASE_URL="${DATABASE_URL:-postgres://review:review@localhost:5433/review}"
# Tests TRUNCATE tables, so they run against a separate database on the same server.
TEST_DB_NAME="${TEST_DB_NAME:-review_test}"
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-${DATABASE_URL%/*}/$TEST_DB_NAME}"
if [ "$TEST_DATABASE_URL" = "$DATABASE_URL" ]; then
  echo "TEST_DATABASE_URL must differ from DATABASE_URL" >&2
  exit 1
fi
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

echo "==> Running knowledge + MCP server tests against $TEST_DATABASE_URL"
# Tests create the test database on demand and never touch DATABASE_URL.
pnpm --filter @review/db test
pnpm --filter @review/knowledge test
pnpm --filter @review/mcp-server test

echo "==> Migrating and ingesting knowledge base (EMBEDDING_PROVIDER=$EMBEDDING_PROVIDER)"
# Ingest last so the real index is populated when smoke finishes.
pnpm --filter @review/knowledge ingest

echo "==> Verifying real index is populated"
if command -v psql >/dev/null 2>&1; then
  COUNT="$(psql "$DATABASE_URL" -Atc 'select count(*) from document_chunks')"
  echo "    document_chunks rows: $COUNT"
  [ "$COUNT" -gt 0 ] || { echo "Real index is empty" >&2; exit 1; }
fi

echo "Phase 2 smoke OK"
