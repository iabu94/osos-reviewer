#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DATABASE_URL="${DATABASE_URL:-postgres://review:review@localhost:5433/review}"
TEST_DB_NAME="${TEST_DB_NAME:-review_test}"
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-${DATABASE_URL%/*}/$TEST_DB_NAME}"
export EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-fake}"

pg_ready() {
  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -d "$DATABASE_URL" >/dev/null 2>&1
  elif command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" -c 'select 1' >/dev/null 2>&1
  else
    docker compose exec -T db pg_isready -U review -d review >/dev/null 2>&1
  fi
}

echo "==> Starting Postgres (optional; reuse if already up)"
if ! docker compose up -d 2>/dev/null; then
  echo "    docker compose not available or failed; continuing if DATABASE_URL is reachable"
fi
for _ in $(seq 1 30); do
  if pg_ready; then
    break
  fi
  sleep 1
done

echo "==> Package tests (@review/teams, orchestrator, db, shared)"
pnpm --filter @review/teams test
pnpm --filter @review/orchestrator test
pnpm --filter @review/db test
pnpm --filter @review/shared test

echo "==> Ephemeral signed webhook POST"
TSX="$ROOT/packages/orchestrator/node_modules/.bin/tsx"
[ -x "$TSX" ] || TSX="$ROOT/packages/teams/node_modules/.bin/tsx"
"$TSX" "$ROOT/scripts/smoke-phase6-webhook.ts"

echo "Phase 6 smoke OK"