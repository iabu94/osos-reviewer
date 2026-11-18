#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DATABASE_URL="${DATABASE_URL:-postgres://review:review@localhost:5433/review}"
TEST_DB_NAME="${TEST_DB_NAME:-review_test}"
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-${DATABASE_URL%/*}/$TEST_DB_NAME}"
if [ "$TEST_DATABASE_URL" = "$DATABASE_URL" ]; then
  echo "TEST_DATABASE_URL must differ from DATABASE_URL" >&2
  exit 1
fi
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

echo "==> Baseline-indexing mismatch + happy fixtures into $TEST_DATABASE_URL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
make_repo() {
  local dir="$1" src="$2"
  mkdir -p "$dir"
  cp -R "$src"/. "$dir"/
  git -C "$dir" init -q
  git -C "$dir" config user.email smoke@example.com
  git -C "$dir" config user.name Smoke
  git -C "$dir" add -A
  git -C "$dir" commit -q -m "fixture"
  git -C "$dir" branch -M develop
}
make_repo "$TMP/be" "$ROOT/packages/code-intel/fixtures/dotnet"
make_repo "$TMP/fe" "$ROOT/packages/code-intel/fixtures/angular"
make_repo "$TMP/be-bad" "$ROOT/packages/code-intel/fixtures/mismatch/backend"
make_repo "$TMP/fe-bad" "$ROOT/packages/code-intel/fixtures/mismatch/frontend"

export REPOS_JSON="[
  {\"id\":\"be\",\"role\":\"backend\",\"localPath\":\"$TMP/be\",\"defaultBaseBranch\":\"develop\"},
  {\"id\":\"fe\",\"role\":\"frontend\",\"localPath\":\"$TMP/fe\",\"defaultBaseBranch\":\"develop\"},
  {\"id\":\"be-bad\",\"role\":\"backend\",\"localPath\":\"$TMP/be-bad\",\"defaultBaseBranch\":\"develop\"},
  {\"id\":\"fe-bad\",\"role\":\"frontend\",\"localPath\":\"$TMP/fe-bad\",\"defaultBaseBranch\":\"develop\"}
]"
export WORKTREE_ROOT="$TMP/worktrees"
for repo in be fe be-bad fe-bad; do
  DATABASE_URL="$TEST_DATABASE_URL" npm run index-baseline -w @review/code-intel --repo-id "$repo"
done

echo "==> Running @review/code-intel and @review/mcp-server tests against $TEST_DATABASE_URL"
npm run test -w @review/code-intel
npm run test -w @review/mcp-server

echo "==> Verifying indexed symbols in test database"
if command -v psql >/dev/null 2>&1; then
  COUNT="$(psql "$TEST_DATABASE_URL" -Atc "select count(*) from code_symbols where index_scope = 'baseline'")"
  echo "    baseline code_symbols rows: $COUNT"
  [ "$COUNT" -gt 0 ] || { echo "Baseline code index is empty" >&2; exit 1; }
fi

echo "Phase 4 smoke OK"