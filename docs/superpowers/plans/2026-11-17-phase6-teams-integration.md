# Phase 6 Teams Integration and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept authenticated Teams review triggers asynchronously, run exactly one review per idempotency key, post Adaptive Card results (including no-findings vs failed) to the originating thread, and harden lifecycle, concurrency, retries, logging, and duration/token benchmarks.

**Architecture:** New `@review/teams` owns webhook auth, Activity-shaped trigger parsing, Adaptive Card building, Bot Connector reply client, and the HTTP server. `@review/db` adds a `reviews` lifecycle table. `@review/orchestrator` gains GitHub PR branch resolution, an in-process review worker (concurrency + retries), and wires `runReview` → card → Teams reply. No Bot Framework SDK; use `node:http` + `fetch` with injectable fakes. CLI local reviews remain available.

**Tech Stack:** TypeScript (Node 22+), pnpm workspaces, Vitest, Zod, `node:crypto` HMAC, `node:http`, Postgres (`reviews` table), existing `runReview` / `ReviewReport` / `NO_FINDINGS_SUMMARY`.

**Spec:** `docs/superpowers/specs/2026-11-16-review-orchestrator-prd.md` (Phase 6 §10; Teams trigger §5.1; Teams delivery §5.8; NFR §6.1–6.5; Workflow §8 steps 1–2, 10–12; Acceptance §9 Teams and Orchestration + Teams Delivery and Operations; Open decision §11.5 resolved below)

## Global Constraints

- Review agent remains Claude Code only; Teams never invokes a different model.
- Reviews stay read-only; Teams path must not loosen Claude tool allow/deny.
- Webhook must acknowledge quickly (`202 Accepted`) and finish the review asynchronously (§6.2).
- Duplicate deliveries with the same idempotency key must not start a second active review (§6.3, §9).
- Auth is required for the Teams endpoint (§6.4); unauthenticated requests return `401`.
- No-findings Adaptive Card body must include exact `NO_FINDINGS_SUMMARY`; failed reviews must not reuse that wording (§5.8, §9).
- Secrets (`TEAMS_WEBHOOK_SECRET`, `TEAMS_BOT_PASSWORD`, `GITHUB_TOKEN`) must never appear in prompts, Adaptive Cards, or structured logs.
- DB-mutating tests use `TEST_DATABASE_URL` via `resolveTestDatabaseUrl` / `ensureDatabase` (never `DATABASE_URL`).
- Do not require a live Teams tenant or live Claude binary in CI smoke; use fakes + HTTP against localhost.

## Review Focus

- Duplicate webhook with same idempotency key while first review is `running` → second request returns `202` with the **same** `reviewId` and does not call `runReview` again.
- Message with no PR URL (or unsupported host) → `400` with structured error; no review row created.
- Completed review with `findings: []` → Adaptive Card text includes exact `NO_FINDINGS_SUMMARY` and is distinct from a failed-review card that shows `error.code`.
- Two concurrent distinct triggers when `maxConcurrentReviews === 1` → second waits until the first finishes; worktree dirs under different `reviewId`s never collide.
- Transient Teams reply failure (`teams_delivery_failed`) → worker retries up to `reviewRetryMax`, then marks review `failed` and logs `reviewId` + attempt count (no silent drop).

## Out of scope (later / ops)

- Azure Bot registration UI, Teams app manifest packaging, or Graph subscriptions
- Multi-tenant Bot Framework JWT validation via Microsoft JWKS (Phase 6 uses shared-secret HMAC; document upgrade path in README)
- Redis/SQS durable queues; in-process worker only
- Hard-failing CI if duration > 30s or tokens outside 2–4k (benchmark records metrics only)
- Changing MCP tools, prompt text, or finding schema from Phase 5

### Pinned decisions (resolves PRD §11.5 for this plan)

| Topic | Decision |
|-------|----------|
| Trigger shape | HTTP `POST /hooks/teams` with Bot Framework **Activity**-shaped JSON (`type`, `id`, `text`/`attachments`, `conversation`, `serviceUrl`, `replyToId` optional) |
| Auth | HMAC-SHA256 hex of **raw body** with `TEAMS_WEBHOOK_SECRET`; client sends `X-Review-Signature: sha256=<hex>`. Constant-time compare. |
| Bot mention | Text (or attachment content) must match `/(^|\s)@?ReviewBot\b/i` **and** contain a PR URL |
| PR URL | Same `parsePrUrl` rules as orchestrator (GitHub-style `…/pull/{n}`) |
| Idempotency key | `activity.id` when present; else `sha256(conversation.id + ":" + normalizedPrUrl)` |
| Reply | `POST {serviceUrl}/v3/conversations/{conversationId}/activities` with Adaptive Card attachment; Bearer token from client-credentials using `TEAMS_BOT_APP_ID` / `TEAMS_BOT_PASSWORD` (fake client in tests) |
| Branch resolution | GitHub REST `GET /repos/{owner}/{repo}/pulls/{n}` with `GITHUB_TOKEN`; map `head.ref` → `primaryBranch`/`headRef`, `base.ref` → `targetBranch` |
| Concurrency | In-process semaphore; default `MAX_CONCURRENT_REVIEWS=2` |
| Retries | Max attempts = `1 + REVIEW_RETRY_MAX` (default `REVIEW_RETRY_MAX=2`); retry only `claude_timeout`, `db_unhealthy`, `teams_delivery_failed` |

### Pinned Adaptive Card constants

```ts
export const CARD_SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";
export const CARD_TYPE = "AdaptiveCard";
export const CARD_VERSION = "1.4";
export const CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";
export const FAILED_REVIEW_TITLE = "Code review failed";
export const COMPLETED_REVIEW_TITLE = "Code review complete";
```

Finding severity shown uppercase in card facts. Max findings rendered in card: `20` (truncate with a TextBlock “N more findings omitted”).

---

## File Structure

```text
packages/
  shared/
    src/
      types.ts              # + TeamsConversationRef, ReviewLifecycleStatus, Teams/AppConfig fields
      config.ts             # + Teams + GitHub + concurrency/retry env
      config.test.ts
      index.ts
  db/
    src/
      sql/005_reviews.sql   # NEW reviews table
      reviews.ts            # NEW claim/get/update helpers
      index.ts
      testing.ts            # truncate includes reviews
  orchestrator/
    src/
      github-pr.ts          # NEW resolvePrBranchesViaGithub
      worker.ts             # NEW enqueue + concurrency + retries + delivery
      log.ts                # NEW structured JSON logger
      cli.ts                # unchanged local path; optional --teams not required
      index.ts
    tests/
      github-pr.test.ts
      worker.test.ts
      log.test.ts
  teams/                    # NEW package @review/teams
    package.json
    tsconfig.json
    vitest.config.ts
    src/
      auth.ts               # verifyTeamsSignature
      parse-trigger.ts      # parseTeamsTrigger
      adaptive-card.ts      # buildReviewAdaptiveCard
      messenger.ts          # TeamsMessenger + createHttpTeamsMessenger / createFakeTeamsMessenger
      server.ts             # createTeamsWebhookServer
      cli.ts                # start webhook server
      index.ts
    tests/
      auth.test.ts
      parse-trigger.test.ts
      adaptive-card.test.ts
      messenger.test.ts
      server.test.ts
    fixtures/
      activity-valid.json
      activity-no-pr.json
      activity-no-mention.json
scripts/
  smoke-phase6.sh
  bench-phase6.sh           # records duration/token JSON; no hard threshold fail
package.json                # + smoke:phase6, bench:phase6
.env.example
README.md
```

---

### Task 1: Shared Teams config + lifecycle types

**Files:**
- Modify: `packages/shared/src/types.ts`, `packages/shared/src/config.ts`, `packages/shared/src/config.test.ts`, `packages/shared/src/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: existing `AppConfig`, `ReviewRequest`, `ReviewResult`
- Produces:
  - `ReviewLifecycleStatus = "accepted" | "running" | "completed" | "failed"`
  - `TeamsConversationRef = { serviceUrl: string; conversationId: string; activityId?: string; replyToId?: string }`
  - Extend `ReviewRequest` so `teamsThreadRef` becomes typed: prefer replacing optional `string` with optional `TeamsConversationRef` **or** add `teamsConversationRef?: TeamsConversationRef` and keep `teamsThreadRef?: string` deprecated unused — **choose:** replace `teamsThreadRef?: string` with `teamsConversationRef?: TeamsConversationRef` (update any references; Phase 1 left it unused)
  - Extend `AppConfig` with:
    - `teams: { webhookSecret: string; botAppId: string; botPassword: string; port: number }`
    - `githubToken?: string`
    - `maxConcurrentReviews: number` (default `2`)
    - `reviewRetryMax: number` (default `2`)
  - `loadConfig` requires `TEAMS_WEBHOOK_SECRET`, `TEAMS_BOT_APP_ID`, `TEAMS_BOT_PASSWORD` only when `REQUIRE_TEAMS=true`; otherwise Teams fields may be empty strings / port `3080` so CLI-only use still works
  - When `REQUIRE_TEAMS=true`, missing secret/app id/password → `ConfigError`
  - Env: `TEAMS_WEBHOOK_PORT` default `3080`; `MAX_CONCURRENT_REVIEWS`; `REVIEW_RETRY_MAX`; `GITHUB_TOKEN` optional unless Teams server starts (Task 6 can require it when starting webhook)

- [ ] **Step 1: Write the failing config tests**

```ts
it("loads Teams and concurrency settings when REQUIRE_TEAMS=true", () => {
  const cfg = loadConfig({
    /* existing required env */,
    REQUIRE_TEAMS: "true",
    TEAMS_WEBHOOK_SECRET: "sec",
    TEAMS_BOT_APP_ID: "app",
    TEAMS_BOT_PASSWORD: "pwd",
    TEAMS_WEBHOOK_PORT: "3099",
    MAX_CONCURRENT_REVIEWS: "1",
    REVIEW_RETRY_MAX: "3",
    GITHUB_TOKEN: "gh",
    EMBEDDING_PROVIDER: "fake",
  });
  expect(cfg.teams.port).toBe(3099);
  expect(cfg.teams.webhookSecret).toBe("sec");
  expect(cfg.maxConcurrentReviews).toBe(1);
  expect(cfg.reviewRetryMax).toBe(3);
  expect(cfg.githubToken).toBe("gh");
});

it("throws ConfigError when REQUIRE_TEAMS=true and secret missing", () => {
  expect(() => loadConfig({ /* … */ REQUIRE_TEAMS: "true", TEAMS_BOT_APP_ID: "a", TEAMS_BOT_PASSWORD: "b" }))
    .toThrow(/TEAMS_WEBHOOK_SECRET/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/shared test`  
Expected: FAIL (unknown config fields / missing assertions)

- [ ] **Step 3: Implement types + `loadConfig` + `.env.example` keys**

Add the types and env parsing. Re-export new types from `index.ts`. Document new env vars in `.env.example` with empty placeholders.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @review/shared test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared .env.example
git commit -m "feat(shared): add Teams config and review lifecycle types"
```

---

### Task 2: `reviews` table and lifecycle store

**Files:**
- Create: `packages/db/src/sql/005_reviews.sql`, `packages/db/src/reviews.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/src/client.test.ts` (or new `packages/db/src/reviews.test.ts`)
- Modify: `packages/db/src/testing.ts` only if truncate helpers list tables explicitly

**Interfaces:**
- Consumes: `ReviewLifecycleStatus`, `TeamsConversationRef`, `ReviewResult` (store as JSONB)
- Produces:
  - SQL table `reviews`:
    - `id VARCHAR(100) PRIMARY KEY`
    - `idempotency_key VARCHAR(255) NOT NULL UNIQUE`
    - `pr_url TEXT NOT NULL`
    - `status VARCHAR(32) NOT NULL` with CHECK in (`accepted`,`running`,`completed`,`failed`)
    - `teams_conversation_ref JSONB`
    - `result JSONB`
    - `error_code VARCHAR(64)`
    - `error_message TEXT`
    - `attempt_count INT NOT NULL DEFAULT 0`
    - `diagnostics JSONB`
    - `created_at` / `updated_at` / `completed_at TIMESTAMPTZ`
  - `claimReview(pool, input: { reviewId: string; idempotencyKey: string; prUrl: string; teamsConversationRef: TeamsConversationRef | null }): Promise<{ kind: "created"; reviewId: string } | { kind: "existing"; reviewId: string; status: ReviewLifecycleStatus }>`
    - Insert; on unique violation of `idempotency_key`, `SELECT` existing and return `existing`
  - `markReviewRunning(pool, reviewId): Promise<void>` — set `status='running'`, bump `attempt_count` by 1, touch `updated_at`
  - `markReviewFinished(pool, reviewId, result: ReviewResult): Promise<void>` — set status from `result.status`, store `result` JSON, error fields, diagnostics, `completed_at=now()`
  - `getReviewByIdempotencyKey(pool, key): Promise<ReviewRow | null>`

- [ ] **Step 1: Write the failing store tests** (skip without `TEST_DATABASE_URL`)

```ts
it("claimReview is idempotent on duplicate key", async () => {
  const a = await claimReview(pool, { reviewId: "r1", idempotencyKey: "act-1", prUrl: "https://github.com/o/r/pull/1", teamsConversationRef: null });
  const b = await claimReview(pool, { reviewId: "r2", idempotencyKey: "act-1", prUrl: "https://github.com/o/r/pull/1", teamsConversationRef: null });
  expect(a.kind).toBe("created");
  expect(b.kind).toBe("existing");
  expect(b.reviewId).toBe("r1");
});

it("markReviewRunning increments attempt_count", async () => {
  await claimReview(pool, { reviewId: "r3", idempotencyKey: "act-3", prUrl: "…", teamsConversationRef: null });
  await markReviewRunning(pool, "r3");
  await markReviewRunning(pool, "r3");
  const row = await getReviewByIdempotencyKey(pool, "act-3");
  expect(row?.attempt_count).toBe(2);
  expect(row?.status).toBe("running");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/db test`  
Expected: FAIL (module/migration missing) when `TEST_DATABASE_URL` set; otherwise skipped

- [ ] **Step 3: Implement migration + store**

Add `005_reviews.sql` and `reviews.ts`; export from `packages/db/src/index.ts`. Ensure `migrate` picks up `005_` lexicographically.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @review/db test`  
Expected: PASS (or skip cleanly without test DB)

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): add reviews lifecycle table for Teams idempotency"
```

---

### Task 3: Adaptive Card builder

**Files:**
- Create: `packages/teams/` package scaffold (`package.json` name `@review/teams`, vitest, tsconfig mirroring `@review/mcp-server`)
- Create: `packages/teams/src/adaptive-card.ts`, `packages/teams/src/index.ts`
- Test: `packages/teams/tests/adaptive-card.test.ts`

**Interfaces:**
- Consumes: `ReviewResult`, `NO_FINDINGS_SUMMARY`, card constants above
- Produces:
  - `buildReviewAdaptiveCard(result: ReviewResult): { contentType: typeof CARD_CONTENT_TYPE; content: AdaptiveCard }`
  - `AdaptiveCard = { $schema: typeof CARD_SCHEMA; type: typeof CARD_TYPE; version: typeof CARD_VERSION; body: unknown[] }`
  - Completed + findings → title `COMPLETED_REVIEW_TITLE`, summary TextBlock, up to 20 finding containers (severity, category, title, evidence, file path/lines when present)
  - Completed + empty findings → body includes TextBlock whose text **equals** `NO_FINDINGS_SUMMARY`
  - Failed → title `FAILED_REVIEW_TITLE`, TextBlocks for `error.code` and `error.message` (no `NO_FINDINGS_SUMMARY`)

- [ ] **Step 1: Write the failing tests**

```ts
it("no-findings card uses NO_FINDINGS_SUMMARY", () => {
  const card = buildReviewAdaptiveCard({
    reviewId: "r",
    status: "completed",
    report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
  });
  expect(card.contentType).toBe(CARD_CONTENT_TYPE);
  expect(card.content.version).toBe("1.4");
  const texts = JSON.stringify(card.content.body);
  expect(texts).toContain(NO_FINDINGS_SUMMARY);
  expect(texts).not.toContain(FAILED_REVIEW_TITLE);
});

it("failed card surfaces error code and omits NO_FINDINGS_SUMMARY", () => {
  const card = buildReviewAdaptiveCard({
    reviewId: "r",
    status: "failed",
    error: { code: "claude_timeout", message: "timed out" },
  });
  const texts = JSON.stringify(card.content.body);
  expect(texts).toContain("claude_timeout");
  expect(texts).toContain(FAILED_REVIEW_TITLE);
  expect(texts).not.toContain(NO_FINDINGS_SUMMARY);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/teams test`  
Expected: FAIL (package/tests not wired yet — scaffold then fail on missing export)

- [ ] **Step 3: Implement `buildReviewAdaptiveCard`**

Pure function; no HTTP. Export card constants from `index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @review/teams test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/teams
git commit -m "feat(teams): build Adaptive Cards from ReviewResult"
```

---

### Task 4: Teams auth, trigger parse, and messenger

**Files:**
- Create: `packages/teams/src/auth.ts`, `packages/teams/src/parse-trigger.ts`, `packages/teams/src/messenger.ts`
- Create: `packages/teams/fixtures/activity-valid.json`, `activity-no-pr.json`, `activity-no-mention.json`
- Test: `packages/teams/tests/auth.test.ts`, `parse-trigger.test.ts`, `messenger.test.ts`

**Interfaces:**
- Consumes: `TeamsConversationRef`, card attachment shape from Task 3
- Produces:
  - `verifyTeamsSignature(rawBody: Buffer | string, signatureHeader: string | undefined, secret: string): boolean` — expect header `sha256=<hex>`; use `crypto.timingSafeEqual` on equal-length buffers; false if missing/malformed
  - `parseTeamsTrigger(activity: unknown): { ok: true; prUrl: string; idempotencyKey: string; conversationRef: TeamsConversationRef } | { ok: false; code: "missing_mention" | "missing_pr_url" | "invalid_activity"; message: string }`
    - Require `type === "message"`
    - Mention + first GitHub PR URL via regex `https?://[^\s]+/pull/\d+`
    - `idempotencyKey = activity.id ?? sha256(conversation.id + ":" + prUrl)`
    - `conversationRef = { serviceUrl, conversationId: conversation.id, activityId: activity.id, replyToId: activity.replyToId }`
  - `TeamsMessenger = { reply(ref: TeamsConversationRef, card: { contentType: string; content: unknown }): Promise<void> }`
  - `createFakeTeamsMessenger(): TeamsMessenger & { sent: Array<{ ref: TeamsConversationRef; card: unknown }> }`
  - `createHttpTeamsMessenger(opts: { appId: string; password: string; fetchImpl?: typeof fetch; getToken?: () => Promise<string> }): TeamsMessenger` — POST activity with `attachments: [{ contentType, content }]`; on non-2xx throw error with code-able message `teams_delivery_failed`

- [ ] **Step 1: Write the failing tests**

```ts
it("accepts valid HMAC signature", () => {
  const body = '{"type":"message"}';
  const sig = /* hmac sha256 hex with secret "sec" */;
  expect(verifyTeamsSignature(body, `sha256=${sig}`, "sec")).toBe(true);
  expect(verifyTeamsSignature(body, "sha256=dead", "sec")).toBe(false);
});

it("parses valid activity fixture", async () => {
  const activity = JSON.parse(await readFile(/* activity-valid.json */));
  const parsed = parseTeamsTrigger(activity);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.prUrl).toMatch(/\/pull\/1$/);
    expect(parsed.idempotencyKey).toBe(activity.id);
  }
});

it("rejects missing PR URL", () => { /* activity-no-pr → missing_pr_url */ });
it("rejects missing ReviewBot mention", () => { /* activity-no-mention → missing_mention */ });

it("fake messenger records replies", async () => {
  const m = createFakeTeamsMessenger();
  await m.reply({ serviceUrl: "https://sm.test", conversationId: "c1" }, { contentType: CARD_CONTENT_TYPE, content: { type: "AdaptiveCard" } });
  expect(m.sent).toHaveLength(1);
});
```

Fixture `activity-valid.json` must include `@ReviewBot`, a GitHub PR URL, `id`, `conversation.id`, `serviceUrl`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @review/teams test`  
Expected: FAIL on new modules

- [ ] **Step 3: Implement auth, parse, messenger**

Keep `createHttpTeamsMessenger` token fetch swappable via `getToken` so unit tests never hit login.microsoftonline.com.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @review/teams test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/teams
git commit -m "feat(teams): authenticate triggers and reply via messenger"
```

---

### Task 5: GitHub PR resolution + review worker

**Files:**
- Create: `packages/orchestrator/src/github-pr.ts`, `packages/orchestrator/src/worker.ts`, `packages/orchestrator/src/log.ts`
- Modify: `packages/orchestrator/src/index.ts`, `packages/orchestrator/package.json` (deps: `@review/teams`, already has `@review/db`)
- Test: `packages/orchestrator/tests/github-pr.test.ts`, `worker.test.ts`, `log.test.ts`

**Interfaces:**
- Consumes: `claimReview` / `markReviewRunning` / `markReviewFinished`, `runReview`, `buildReviewAdaptiveCard`, `TeamsMessenger`, `AppConfig`, `PrBranches`
- Produces:
  - `createLogger(base?: Record<string, unknown>): { info, warn, error }` — each call writes one JSON line to stdout with `timestamp`, `level`, `msg`, plus fields; never log secret-looking keys (`password`, `token`, `secret`, `authorization`)
  - `resolvePrBranchesViaGithub(prUrl: string, opts: { token: string; fetchImpl?: typeof fetch }): Promise<PrBranches>` — parse URL; `GET https://api.github.com/repos/{owner}/{repo}/pulls/{number}` with `Authorization: Bearer ${token}`, `Accept: application/vnd.github+json`; map refs; throw/`Error` with message including status on failure
  - `ReviewWorker` via `createReviewWorker(deps)`:
    ```ts
    type ReviewWorkerDeps = {
      pool: Pool;
      config: AppConfig;
      messenger: TeamsMessenger;
      runReview: typeof runReview;
      buildReviewDeps: (prUrl: string) => Promise<ReviewDeps>; // supplies getPrBranches via GitHub, listRemoteBranches, claude, mcp, requireDb: true
      logger?: ReturnType<typeof createLogger>;
      maxConcurrent?: number; // default config.maxConcurrentReviews
      retryMax?: number; // default config.reviewRetryMax
    };
    type EnqueueInput = {
      prUrl: string;
      idempotencyKey: string;
      teamsConversationRef: TeamsConversationRef;
      reviewId?: string; // default randomUUID hex without dashes
    };
    // enqueue(input) => Promise<{ reviewId: string; duplicated: boolean }>
    ```
  - `enqueue` flow:
    1. `claimReview`; if `existing` and status in `accepted|running|completed|failed` → return `{ reviewId: existing.reviewId, duplicated: true }` **without** scheduling another job (even for `failed`/`completed` — duplicates are no-ops)
    2. else schedule background job (do not await review completion inside `enqueue`)
  - Job flow (single scheduled job per created claim):
    1. Acquire semaphore (`maxConcurrent` slots)
    2. `let last: ReviewResult | undefined`
    3. `for (let attempt = 0; attempt <= retryMax; attempt++)`:
       - `markReviewRunning(reviewId)` (increments `attempt_count`)
       - `last = await runReview({ prUrl, reviewId, teamsConversationRef }, await buildReviewDeps(prUrl))`
       - try `await messenger.reply(ref, buildReviewAdaptiveCard(last))`; on throw set `last = { …last, status: "failed", error: { code: "teams_delivery_failed", message } }` (preserve prior `report` if any only when useful — prefer replace with failed delivery result)
       - if `last.status === "completed"` → break
       - if `last.error?.code` not in retryable set → break
       - if `attempt < retryMax` → `await sleep(min(1000 * 2 ** attempt, 5000))`
    4. `markReviewFinished(pool, reviewId, last!)`
    5. Release semaphore
  - Retryable codes (exact): `claude_timeout`, `db_unhealthy`, `teams_delivery_failed`
  - Semaphore ensures at most `maxConcurrent` jobs execute the loop body simultaneously

- [ ] **Step 1: Write the failing tests**

```ts
it("resolvePrBranchesViaGithub maps head and base refs", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ head: { ref: "feature/ABC-1" }, base: { ref: "develop" } }), { status: 200 });
  const b = await resolvePrBranchesViaGithub("https://github.com/acme/be/pull/9", { token: "t", fetchImpl });
  expect(b).toEqual({ primaryBranch: "feature/ABC-1", targetBranch: "develop", headRef: "feature/ABC-1" });
});

it("duplicate enqueue does not runReview twice", async () => {
  let runs = 0;
  const worker = createReviewWorker({
    /* pool with migrate, fake messenger, */
    runReview: async (req) => {
      runs++;
      return { reviewId: req.reviewId, status: "completed", report: { summary: NO_FINDINGS_SUMMARY, findings: [] } };
    },
    buildReviewDeps: async () => fakeDeps,
    config,
    messenger: createFakeTeamsMessenger(),
    maxConcurrent: 1,
    retryMax: 0,
  });
  const a = await worker.enqueue({ prUrl, idempotencyKey: "k1", teamsConversationRef });
  const b = await worker.enqueue({ prUrl, idempotencyKey: "k1", teamsConversationRef });
  await worker.drain(); // expose drain(): Promise<void> waiting for in-flight jobs — required for tests
  expect(a.duplicated).toBe(false);
  expect(b.duplicated).toBe(true);
  expect(a.reviewId).toBe(b.reviewId);
  expect(runs).toBe(1);
  expect(messenger.sent).toHaveLength(1);
});

it("maxConcurrentReviews=1 serializes two jobs", async () => { /* gate with deferred promises; assert overlap false */ });

it("retries teams_delivery_failed then succeeds", async () => { /* messenger fails once then ok; retryMax=1; expect attempt_count behavior / two reply tries */ });
```

`drain()` is part of the worker public API for tests and graceful shutdown.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @review/orchestrator test`  
Expected: FAIL on new files

- [ ] **Step 3: Implement github-pr, log, worker**

Wire exports from `packages/orchestrator/src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @review/orchestrator test`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator
git commit -m "feat(orchestrator): add Teams review worker with idempotency"
```

---

### Task 6: Webhook server, smoke, benchmark, docs

**Files:**
- Create: `packages/teams/src/server.ts`, `packages/teams/src/cli.ts`
- Test: `packages/teams/tests/server.test.ts`
- Create: `scripts/smoke-phase6.sh`, `scripts/bench-phase6.sh`
- Modify: root `package.json`, `README.md`, `packages/teams/package.json` scripts (`start` via tsx + env file)

**Interfaces:**
- Consumes: Tasks 1–5
- Produces:
  - `createTeamsWebhookServer(opts: { secret: string; worker: { enqueue: ReviewWorker["enqueue"] }; logger?: … }): http.Server`
    - `POST /hooks/teams`: read raw body → verify signature → `parseTeamsTrigger` → `worker.enqueue` → respond `202` JSON `{ reviewId, duplicated, status: "accepted" }`
    - bad signature → `401` `{ error: "unauthorized" }`
    - parse failure → `400` `{ error: code, message }`
    - `GET /healthz` → `200` `{ ok: true }`
  - CLI `pnpm --filter @review/teams start` loads config with `REQUIRE_TEAMS=true`, migrates DB, builds real messenger + worker (`requireDb: true`, GitHub branch resolver), listens on `config.teams.port`
  - Smoke: docker up → migrate → start server with fake messenger injected **or** unit-level: run `@review/teams` + `@review/orchestrator` worker/github tests + `@review/db` reviews tests; POST signed fixture to ephemeral server with fake worker; print `Phase 6 smoke OK`
  - Bench: script runs worker once with fake `runReview` returning diagnostics `{ durationMs, inputTokens, outputTokens }`, writes `bench-phase6-out.json` with those fields + wall-clock; exit 0 even if duration > 30000 (log a warning if wall clock > 30000)
  - README Phase 6 section: webhook path, auth header, env vars, Adaptive Card behavior, async 202, idempotency, concurrency, note HMAC vs full Bot Framework JWT

- [ ] **Step 1: Write the failing server tests**

```ts
it("POST /hooks/teams returns 202 and enqueues", async () => {
  const enqueues: unknown[] = [];
  const server = createTeamsWebhookServer({
    secret: "sec",
    worker: { enqueue: async (input) => { enqueues.push(input); return { reviewId: "rid", duplicated: false }; } },
  });
  await listen(server);
  const body = await readFile(/* activity-valid.json */);
  const res = await fetch(url + "/hooks/teams", {
    method: "POST",
    headers: { "content-type": "application/json", "x-review-signature": `sha256=${hmac(body, "sec")}` },
    body,
  });
  expect(res.status).toBe(202);
  expect(enqueues).toHaveLength(1);
});

it("rejects bad signature with 401", async () => { /* … */ });
it("rejects activity without PR with 400 missing_pr_url", async () => { /* … */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @review/teams test`  
Expected: FAIL on server

- [ ] **Step 3: Implement server, CLI, smoke, bench, README**

Ensure graceful `SIGINT` calls `worker.drain()` then closes server (best-effort).

- [ ] **Step 4: Run tests and smoke**

Run:
```bash
pnpm --filter @review/teams test
pnpm --filter @review/orchestrator test
pnpm --filter @review/db test
pnpm --filter @review/shared test
./scripts/smoke-phase6.sh
./scripts/bench-phase6.sh
```
Expected: PASS; smoke prints `Phase 6 smoke OK`; bench writes JSON and exits 0

- [ ] **Step 5: Commit**

```bash
git add packages/teams packages/orchestrator scripts package.json README.md .env.example
git commit -m "feat(teams): webhook server, smoke, and review benchmarks"
```

---

## Self-Review

1. **Spec coverage:** §5.1 trigger + validate + retain thread ref → Tasks 4–6. §5.8 Adaptive Card + no-findings wording → Task 3 (+ delivery Task 5–6). §6.1 token recording → diagnostics already on `ReviewResult`; bench Task 6. §6.2 async webhook + timeouts (existing Claude timeout) + status on failure → Tasks 5–6. §6.3 idempotency, retries, concurrency, lifecycle, cleanup (existing `runReview` finally) → Tasks 2 + 5. §6.4 auth + secrets not in logs → Tasks 1, 4, 5 logger. §6.5 structured logs with reviewId → Task 5 `log.ts` used by worker/server. §8 steps 1–2, 10–12 → Tasks 5–6. §9 Teams acceptance → server/worker tests. §10 Phase 6 bullets → all tasks. §11.5 method pinned in plan header.
2. **Step scan:** Signatures, env names, status codes, error codes, card constants, and idempotency behavior are pinned; Adaptive Card layout details beyond title/summary/findings/failure left to implementer; Bot JWT upgrade documented not implemented.
3. **Type consistency:** `TeamsConversationRef`, `ReviewLifecycleStatus`, `claimReview` / `enqueue` / `buildReviewAdaptiveCard` / `verifyTeamsSignature` / `parseTeamsTrigger` names align across tasks; `teams_delivery_failed` retryable; `NO_FINDINGS_SUMMARY` reused from shared.
4. **Review Focus:** Each of the five bullets has an owning test (duplicate enqueue; missing PR 400; no-findings vs failed cards; concurrency=1; delivery retry).
5. **Proportion:** Plan decides boundaries and contracts; does not paste full Adaptive Card JSON templates or Bot Connector payload transcripts.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-17-phase6-teams-integration.md`.
