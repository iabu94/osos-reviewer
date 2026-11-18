# npm + NestJS Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the same review platform on npm workspaces with a NestJS HTTP app for Teams, without changing webhook contracts, env vars, review behavior, or existing package tests.

**Architecture:** Keep `packages/*` as plain TypeScript libraries. Replace pnpm with npm workspaces (`*` deps). Add `apps/api` as the NestJS host that wires config, DB pool, messenger, review worker, and HTTP routes by delegating to extracted `@review/teams` handlers (same status codes and bodies as today). `createTeamsWebhookServer` stays as a thin `node:http` adapter over that handler so current Teams server tests keep passing. Orchestrator CLI (`start` with `--pr-url`) stays in `@review/orchestrator`; only `start:teams` / root `start` move to Nest.

**Tech Stack:** Node 22+, npm workspaces, NestJS 11 (`@nestjs/common` / `@nestjs/core` / `@nestjs/platform-express`), Vitest (unchanged), existing `@review/*` packages, `tsx` for Nest bootstrap (ESM, matching the monorepo).

**Spec:** Informal — brainstorming opted out. Behavioral source of truth: `README.md` architecture + `packages/teams/src/server.ts` HTTP contract + existing Vitest/smoke scripts.

## Global Constraints

- Node `>=22`; package manager is **npm** (not pnpm); no `workspace:*` protocol.
- Do **not** Nest-ify library packages (`shared`, `db`, `teams`, `orchestrator`, etc.) — only `apps/api` uses Nest DI/decorators.
- Preserve routes: `GET /healthz` → `200 { ok: true }`; `POST /teams-hook` → same auth, 401/400/202/200/500 bodies as `createTeamsWebhookServer` today.
- Preserve env loading: Nest entry uses `tsx --env-file=../../.env` (or repo-root `.env`) and `loadConfig` with `REQUIRE_TEAMS=true`.
- Preserve default Teams port `3080` from `loadConfig`.
- Existing package Vitest suites must pass without rewriting assertions; smoke scripts must pass after `pnpm` → `npm` command updates.
- Historical `docs/superpowers/plans/*` and old phase specs may still say pnpm — leave them; update `README.md` and live scripts only.
- Nest `apps/api` is `"type": "module"` with `experimentalDecorators` + `emitDecoratorMetadata` only in that app's tsconfig.

## Review Focus

- Raw body for HMAC: Nest/Express must not parse JSON before `verifyTeamsRequest` sees the exact bytes — regression covered in Nest e2e test using the same fixtures as Teams server tests.
- npm workspace linking: `@review/*` resolve after `npm install` without `workspace:*` — covered by root `npm test`.
- Concurrent reviews / worker drain on SIGTERM — Nest shutdown hooks call the same `worker.drain()` + `pool.end()` path as `teams-cli`.
- `Authorization: HMAC …` (Teams outgoing) vs `x-review-signature` paths both still work through Nest controller.
- MCP launch still resolves `tsx` + `packages/mcp-server/src/index.ts` relative to monorepo layout after moving the HTTP entry to `apps/api`.

---

### Task 1: Switch monorepo from pnpm to npm workspaces

**Files:**
- Modify: `package.json`
- Create: (none — use root `workspaces`)
- Delete: `pnpm-workspace.yaml`, `pnpm-lock.yaml` (after lockfile regenerate)
- Modify: every `packages/*/package.json` — replace `"workspace:*"` with `"*"`
- Modify: `scripts/smoke-phase1.sh` … `scripts/smoke-phase6.sh`, `scripts/bench-phase6.sh` — `pnpm` → `npm`
- Modify: `README.md`, `.agents/skills/updating-knowledge-base/SKILL.md` — install/run commands to npm
- Test: existing package tests via root `npm test`

**Interfaces:**
- Consumes: current package graph and scripts
- Produces: npm workspaces root with `"workspaces": ["packages/*", "apps/*"]` (include `apps/*` early so Task 3 installs cleanly); root scripts using `npm run … --workspaces --if-present` and `npm run <script> -w <pkg>`

- [ ] **Step 1: Write a failing check that root scripts no longer invoke pnpm**

Add `scripts/assert-npm-workspace.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
grep -q '"workspaces"' package.json
! grep -R --include='package.json' -n 'workspace:\*' packages package.json
! grep -E 'pnpm ' package.json
test ! -f pnpm-workspace.yaml
```

- [ ] **Step 2: Run assert script to verify it fails**

Run: `bash ./scripts/assert-npm-workspace.sh`
Expected: FAIL (pnpm still present / `workspace:*` still present)

- [ ] **Step 3: Convert workspace config and deps**

In root `package.json`:
- Add `"workspaces": ["packages/*", "apps/*"]`
- Remove `"packageManager": "pnpm@9.15.0"`
- Set scripts to:
  - `"start": "npm run start:teams -w @review/api"` (temporary: keep pointing at orchestrator until Task 4; for this task only, keep `"start": "npm run start:teams -w @review/orchestrator"`)
  - `"test": "npm run test --workspaces --if-present"`
  - `"build": "npm run build --workspaces --if-present"`
  - `"typecheck": "npm run typecheck --workspaces --if-present"`
- Replace every `"@review/…": "workspace:*"` with `"@review/…": "*"` in `packages/*/package.json`
- Delete `pnpm-workspace.yaml`
- Update all `scripts/*.sh` and `README.md` / skill docs: `pnpm install` → `npm install`; `pnpm --filter <pkg> <cmd>` → `npm run <cmd> -w <pkg>`; `pnpm test` → `npm test`
- Run `npm install` at repo root (generates `package-lock.json`); delete `pnpm-lock.yaml`

- [ ] **Step 4: Run assert + full unit tests**

Run: `bash ./scripts/assert-npm-workspace.sh && npm test`
Expected: assert OK; all workspace Vitest suites PASS (same as before; DB-backed tests still need `TEST_DATABASE_URL` when run via smokes)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json packages/*/package.json scripts README.md .agents/skills/updating-knowledge-base/SKILL.md
git rm -f pnpm-workspace.yaml pnpm-lock.yaml
git add scripts/assert-npm-workspace.sh
git commit -m "$(cat <<'EOF'
build: switch monorepo from pnpm to npm workspaces

Keep package layout and scripts equivalent so installs and tests no longer depend on pnpm.
EOF
)"
```

---

### Task 2: Extract shared Teams HTTP handler from `node:http` server

**Files:**
- Create: `packages/teams/src/handle-request.ts`
- Modify: `packages/teams/src/server.ts` — call handler; keep `createTeamsWebhookServer` signature
- Modify: `packages/teams/src/index.ts` — export handler types/functions
- Test: `packages/teams/tests/server.test.ts` (unchanged assertions)
- Create: `packages/teams/tests/handle-request.test.ts` — one unit test on status mapping without listening

**Interfaces:**
- Consumes: `verifyTeamsRequest`, `parseTeamsTrigger`, `TeamsWebhookWorker`, `TeamsWebhookLogger`
- Produces:

```ts
export type TeamsHttpResult = {
  status: number;
  body: unknown;
};

export type TeamsHttpRequest = {
  method: string;
  path: string; // URL path without query
  headers: { signature?: string; authorization?: string };
  rawBody: Buffer;
};

export function handleTeamsHttpRequest(
  req: TeamsHttpRequest,
  opts: { secret: string; worker: TeamsWebhookWorker; logger?: TeamsWebhookLogger },
): Promise<TeamsHttpResult>;
```

Behavior must match current `server.ts` (healthz, teams-hook auth modes, enqueue, 404, 500).

- [ ] **Step 1: Write failing test for handler healthz**

In `packages/teams/tests/handle-request.test.ts`:

```ts
it("GET /healthz returns 200 { ok: true }", async () => {
  const result = await handleTeamsHttpRequest(
    { method: "GET", path: "/healthz", headers: {}, rawBody: Buffer.alloc(0) },
    { secret: "sec", worker: { enqueue: async () => ({ reviewId: "x", duplicated: false }) } },
  );
  expect(result).toEqual({ status: 200, body: { ok: true } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @review/teams -- handle-request.test.ts`
Expected: FAIL with `handleTeamsHttpRequest` not defined / cannot resolve module

- [ ] **Step 3: Implement `handleTeamsHttpRequest` and refactor `createTeamsWebhookServer`**

Move route logic from `server.ts` into `handle-request.ts`. `createTeamsWebhookServer` reads raw body + headers, calls handler, writes JSON. Export from `index.ts`.

- [ ] **Step 4: Run Teams tests**

Run: `npm run test -w @review/teams`
Expected: PASS (including existing `server.test.ts`)

- [ ] **Step 5: Commit**

```bash
git add packages/teams
git commit -m "$(cat <<'EOF'
refactor(teams): extract HTTP handler for Nest and node:http

Keep createTeamsWebhookServer as a thin adapter so existing webhook tests stay valid.
EOF
)"
```

---

### Task 3: Scaffold NestJS app `apps/api` (@review/api)

**Files:**
- Create: `apps/api/package.json` (`name`: `@review/api`)
- Create: `apps/api/tsconfig.json` (extends `../../tsconfig.base.json` + `experimentalDecorators`, `emitDecoratorMetadata`, `rootDir`/`outDir` for Nest)
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/health.controller.ts` — temporary stub until Task 4 wires real handler
- Test: `apps/api/src/health.controller.spec.ts` (Vitest)

**Interfaces:**
- Consumes: Nest 11 packages; workspace deps `@review/shared`, `@review/teams`, `@review/db`, `@review/orchestrator` (declared in Task 4 if not needed yet — for this task only `@nestjs/*` + vitest)
- Produces: runnable Nest process with `GET /healthz` → `{ ok: true }` via Nest controller; scripts:
  - `"start:teams": "REQUIRE_TEAMS=true tsx --env-file=../../.env src/main.ts"`
  - `"test": "vitest run"`
  - `"typecheck": "tsc -p tsconfig.json --noEmit"`

- [ ] **Step 1: Write failing Nest health test**

```ts
// apps/api/src/health.controller.spec.ts
import { Test } from "@nestjs/testing";
import { HealthController } from "./health.controller.js";

it("GET healthz returns { ok: true }", async () => {
  const mod = await Test.createTestingModule({
    controllers: [HealthController],
  }).compile();
  const controller = mod.get(HealthController);
  expect(controller.healthz()).toEqual({ ok: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm install && npm run test -w @review/api -- health.controller.spec.ts`
Expected: FAIL (package / controller missing)

- [ ] **Step 3: Scaffold Nest app**

Create `@review/api` with dependencies `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, `reflect-metadata`, `rxjs`. `HealthController` with `@Get('healthz')`. `main.ts`: `NestFactory.create(AppModule)`, `app.listen(process.env.PORT ?? 3080)` for this scaffold only — Task 4 switches listen port to `loadConfig(…).teams.port` and `REQUIRE_TEAMS`.

- [ ] **Step 4: Run api tests**

Run: `npm run test -w @review/api`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api package-lock.json package.json
git commit -m "$(cat <<'EOF'
feat(api): scaffold NestJS app workspace package

Add a minimal Nest host so Teams HTTP can move off the raw node:http CLI entry.
EOF
)"
```

---

### Task 4: Wire Nest to real Teams handler, worker, and config

**Files:**
- Create: `apps/api/src/config.module.ts` / `apps/api/src/review-tokens.ts` (injection tokens)
- Create: `apps/api/src/teams.controller.ts`
- Create: `apps/api/src/review-app.providers.ts` — factory providers that mirror `startTeamsWebhookCli` wiring (pool, migrate, messenger, `createReviewWorker`, MCP launch paths)
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/main.ts` — enable raw body for `/teams-hook`; register shutdown hooks
- Modify: `apps/api/package.json` — depend on `@review/shared`, `@review/teams`, `@review/db`, `@review/orchestrator`
- Modify: root `package.json` `"start"` → `npm run start:teams -w @review/api`
- Modify: `packages/orchestrator/package.json` — keep `start:teams` but make it re-export/delegate to `@review/api` **or** leave as deprecated thin wrapper that imports Nest bootstrap; prefer: orchestrator `start:teams` prints deprecation and `execa`/`spawn` of api start **or** simply document Nest as canonical and leave `teams-cli.ts` for tests that import `startTeamsWebhookCli` if any
- Create: `apps/api/tests/teams-webhook.e2e.test.ts` — Nest `app.getHttpServer()` + same fixtures/HMAC as `packages/teams/tests/server.test.ts` for 202 + Teams HMAC 200 paths
- Modify: `packages/orchestrator/src/teams-cli.ts` — extract shared `buildTeamsRuntime(env)` used by both Nest providers and optional CLI, **or** Nest duplicates wiring once carefully; prefer single `buildTeamsRuntime` in orchestrator exported for Nest to call

**Interfaces:**
- Consumes: `handleTeamsHttpRequest`, `loadConfig`, `createPool`/`migrate`, `createReviewWorker`, `runReview`, messengers, `resolvePrBranchesViaGithub`, `createGithubReviewPoster`
- Produces:

```ts
// packages/orchestrator/src/teams-runtime.ts
export type TeamsRuntime = {
  config: AppConfig;
  pool: Pool;
  worker: ReturnType<typeof createReviewWorker>;
  shutdown: () => Promise<void>;
};
export function createTeamsRuntime(env: NodeJS.ProcessEnv): Promise<TeamsRuntime>;
```

Nest `TeamsController`:
- `GET /healthz` → handler
- `POST /teams-hook` → raw body + headers → `handleTeamsHttpRequest`
MCP launch must resolve `packages/mcp-server/src/index.ts` from repo layout (not `apps/api`-relative wrong path) — reuse `resolveMcpLaunch` moved into `teams-runtime.ts`.

- [ ] **Step 1: Write failing Nest e2e test for POST /teams-hook 202**

Use TestingModule or full `NestFactory` with fake worker provider; assert status 202 and enqueue payload match `activity-valid.json` + `x-review-signature` (copy assertion pattern from `server.test.ts`).

- [ ] **Step 2: Run e2e to verify it fails**

Run: `npm run test -w @review/api -- teams-webhook.e2e.test.ts`
Expected: FAIL (controller/route not wired)

- [ ] **Step 3: Implement `createTeamsRuntime` + Nest TeamsController + raw body**

Approach: Express `verify` / `rawBody` buffer on request; controller passes `Buffer` into `handleTeamsHttpRequest`. `main.ts` creates runtime before Nest listen, provides worker/secret via custom providers, registers `enableShutdownHooks`, on destroy calls `runtime.shutdown()`. Port = `runtime.config.teams.port`.

- [ ] **Step 4: Run api + teams + orchestrator tests**

Run: `npm run test -w @review/api && npm run test -w @review/teams && npm run test -w @review/orchestrator`
Expected: PASS

- [ ] **Step 5: Point root start at Nest; keep orchestrator CLI for PR reviews**

Root `"start"` → `@review/api` `start:teams`. Orchestrator `"start"` (PR CLI) unchanged. Either delete `teams-cli` main entry or make `startTeamsWebhookCli` call `createTeamsRuntime` + `createTeamsWebhookServer` for backward compatibility smoke — keep function for any import tests; Nest is production entry.

- [ ] **Step 6: Commit**

```bash
git add apps/api packages/orchestrator package.json package-lock.json README.md
git commit -m "$(cat <<'EOF'
feat(api): serve Teams webhook through NestJS

Wire the existing handler and review runtime so HTTP behavior stays identical on npm.
EOF
)"
```

---

### Task 5: Smoke verification and README finalization

**Files:**
- Modify: `README.md` — Prerequisites npm; Architecture diagram note Nest `@review/api`; Setup/`start:teams` commands
- Modify: `scripts/smoke-phase6.sh` if it assumes orchestrator `start:teams` path for process checks — point at `@review/api` when applicable
- Test: `scripts/smoke-phase1.sh`, `scripts/smoke-phase6.sh` (and others if time; minimum phase1 + phase6)

**Interfaces:**
- Consumes: Tasks 1–4
- Produces: documented npm + Nest entry; green smokes

- [ ] **Step 1: Update README architecture + commands for Nest/npm**

Document: `npm install`, `npm start` → Nest Teams app, `npm run start -w @review/orchestrator -- --pr-url …` for CLI reviews.

- [ ] **Step 2: Run phase1 and phase6 smokes**

Run: `bash ./scripts/smoke-phase1.sh && bash ./scripts/smoke-phase6.sh`
Expected: both exit 0

- [ ] **Step 3: Commit**

```bash
git add README.md scripts
git commit -m "$(cat <<'EOF'
docs: document npm workspaces and NestJS Teams entry

Align README and smokes with the Nest @review/api start path.
EOF
)"
```

---

## Self-Review Notes

- Spec coverage: npm swap, Nest host, unchanged webhook contract, library packages untouched, tests/smokes — each has a task.
- Non-goals locked: no Nest modules inside `@review/db` / MCP / code-intel; no pnpm compatibility layer.
- Type consistency: `handleTeamsHttpRequest` → Nest controller; `createTeamsRuntime` → Nest providers and optional CLI.
