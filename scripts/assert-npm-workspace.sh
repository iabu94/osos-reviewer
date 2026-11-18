#!/usr/bin/env bash
set -euo pipefail
grep -q '"workspaces"' package.json
! grep -R --include='package.json' -n 'workspace:\*' packages package.json
! grep -E 'pnpm ' package.json
test ! -f pnpm-workspace.yaml
