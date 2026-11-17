#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://review:review@localhost:5433/review_test}"
export EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-fake}"

TSX="$ROOT/packages/orchestrator/node_modules/.bin/tsx"
[ -x "$TSX" ] || TSX="$ROOT/packages/teams/node_modules/.bin/tsx"
"$TSX" "$ROOT/scripts/bench-phase6.ts"