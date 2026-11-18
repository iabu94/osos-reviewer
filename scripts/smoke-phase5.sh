#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-fake}"

echo "==> Running @review/orchestrator tests (fake Claude only)"
npm run test -w @review/orchestrator

if command -v claude >/dev/null 2>&1; then
  echo "==> Skipping live claude invoke (billing); binary present: $(command -v claude)"
fi

echo "Phase 5 smoke OK"