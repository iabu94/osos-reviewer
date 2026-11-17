#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DATABASE_URL="${DATABASE_URL:-postgres://review:review@localhost:5433/review}"
# DB tests truncate tables; keep them off the real database.
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-${DATABASE_URL%/*}/review_test}"

echo "==> Starting Postgres (pgvector on host port 5433)"
docker compose up -d
for i in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U review -d review >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "==> Running unit tests"
pnpm test

echo "==> DB health via @review/db tests"
pnpm --filter @review/db test -- client.test.ts

if command -v claude >/dev/null 2>&1; then
  echo "==> claude CLI found (real headless invoke is optional; skipped in smoke)"
else
  echo "==> claude CLI not installed; skipping live Claude invoke"
fi

echo "Phase 1 smoke OK"
