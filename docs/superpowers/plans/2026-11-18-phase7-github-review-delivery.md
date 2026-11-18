# Phase 7 GitHub Review Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After each Teams-triggered review finishes, post a GitHub `COMMENT` pull-request review (summary + eligible inline notes) to the trigger PR without changing Teams Adaptive Card delivery.

**Architecture:** Extend `@review/orchestrator` GitHub helpers: PR lookup returns `headSha` and PR file paths; a pure markdown/mapper builds the review payload; `postPullRequestReview` creates the review idempotently via an HTML `reviewId` marker. The existing worker delivers GitHub then Teams, with `github_delivery_failed` retryable and in-job skip after a successful GitHub post.

**Tech Stack:** TypeScript (Node 22+), pnpm workspaces, Vitest, `fetch` + `GITHUB_TOKEN`, existing `ReviewResult` / `NO_FINDINGS_SUMMARY` / `parsePrUrl` / `createReviewWorker`.

**Spec:** `docs/superpowers/specs/2026-11-18-github-review-delivery-design.md` (parent PRD `docs/superpowers/specs/2026-11-16-review-orchestrator-prd.md` §1.3 non-goals; Teams delivery remains §5.8)

## Global Constraints

- GitHub review `event` is always `COMMENT` — never `APPROVE` or `REQUEST_CHANGES`.
- Do not post from local CLI `runReview`; only the Teams worker path posts.
- Secrets (`GITHUB_TOKEN`, Teams secrets) must never appear in PR review bodies or structured logs.
- Exact `NO_FINDINGS_SUMMARY` string for empty-findings completed reviews; failed reviews must not use it.
- Idempotency marker in every review body: `<!-- review-orchestrator:reviewId=<reviewId> -->`.
- Inline comments capped at `20`; overflow stays in body only.
- Companion-repo / missing-line findings never cause GitHub API line-comment failures — they go in the body.
- DB-mutating tests continue to use `TEST_DATABASE_URL` only; GitHub tests use fake `fetchImpl` (no live GitHub in CI).

## Review Focus

- Finding with `repo` matching a **different** repo than the trigger PR → body only; no inline comment; POST still `200`-path success.
- Finding with `filePath` not in `GET .../pulls/{n}/files` → body only; create review still succeeds.
- Second worker attempt after GitHub already posted (marker present or `githubDelivered`) → no second `POST .../reviews`.
- `GITHUB_REVIEW_DELIVERY=false` → zero GitHub review API calls; Teams still replied.
- Transient GitHub `500` on create → `github_delivery_failed`, retry, then succeed or mark failed; Teams not treated as success if the job ends failed for GitHub after exhausting retries.

## Out of scope

- Companion PR posting, Checks API, issue-only comments as the primary channel
- Approving / requesting changes / merging
- CLI opt-in GitHub posting
- Editing or dismissing prior bot reviews beyond skip-if-marker-present

### Pinned decisions

| Topic | Decision |
|-------|----------|
| API | `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with `commit_id`, `event: "COMMENT"`, `body`, optional `comments[]` |
| Inline eligibility | `filePath` + positive `lineStart` + repo matches trigger (or `repo` omitted) + path in PR files |
| Multi-line | When `lineEnd > lineStart`, send GitHub multi-line fields; else single `line` |
| Idempotency | Skip create if any existing review body contains the marker for this `reviewId` |
| Order | GitHub then Teams per attempt |
| Retryable codes | existing + `github_delivery_failed` |
| Config | `githubReviewDelivery: boolean` from `GITHUB_REVIEW_DELIVERY` (`true`/`false`); default `true` if unset when `githubToken` is set, else `false` |
| Marker | `<!-- review-orchestrator:reviewId=${reviewId} -->` |

### File structure

```text
packages/
  shared/
    src/
      types.ts                 # + githubReviewDelivery on AppConfig
      config.ts                # parse GITHUB_REVIEW_DELIVERY
      config.test.ts
  orchestrator/
    src/
      github-pr.ts             # + headSha; listPullFiles / enrich resolve
      github-review-markdown.ts  # NEW pure mapper
      github-review.ts         # NEW postPullRequestReview + idempotent skip
      worker.ts                # GitHub deliver before Teams
      index.ts                 # exports
      teams-cli.ts             # wire github poster deps if needed
    tests/
      github-pr.test.ts        # extend or add
      github-review-markdown.test.ts
      github-review.test.ts
      worker.test.ts           # GitHub delivery cases
  .env.example                 # GITHUB_REVIEW_DELIVERY
  README.md                    # Phase 7 section
```

---

### Task 1: Config flag `githubReviewDelivery`

**Files:**
- Modify: `packages/shared/src/types.ts` (`AppConfig`)
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/config.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: existing `loadConfig`, `GITHUB_TOKEN`
- Produces: `AppConfig.githubReviewDelivery: boolean`

- [ ] **Step 1: Write the failing test**

In `config.test.ts`, assert:

```ts
expect(loadConfig({ ...base, GITHUB_TOKEN: "gh" }).githubReviewDelivery).toBe(true);
expect(loadConfig({ ...base, GITHUB_TOKEN: "gh", GITHUB_REVIEW_DELIVERY: "false" }).githubReviewDelivery).toBe(false);
expect(loadConfig({ ...base /* no token */, GITHUB_REVIEW_DELIVERY: "true" }).githubReviewDelivery).toBe(false);
```

(Third case: even if env says true, without token delivery is false — avoids POST without auth.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/shared test -- config.test.ts -t githubReviewDelivery`  
Expected: FAIL (property missing or wrong default)

- [ ] **Step 3: Implement config**

Add `githubReviewDelivery: boolean` to `AppConfig`. In `loadConfig`:

```ts
githubReviewDelivery:
  Boolean(env.GITHUB_TOKEN) && env.GITHUB_REVIEW_DELIVERY !== "false",
```

If `GITHUB_REVIEW_DELIVERY === "true"` but no token → still `false`.  
Document `GITHUB_REVIEW_DELIVERY=true|false` in `.env.example`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @review/shared test -- config.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/config.ts packages/shared/src/config.test.ts .env.example
git commit -m "feat(shared): add githubReviewDelivery config flag"
```

---

### Task 2: Extend GitHub PR lookup (`headSha` + file paths)

**Files:**
- Modify: `packages/orchestrator/src/github-pr.ts`
- Create or modify: `packages/orchestrator/tests/github-pr.test.ts`
- Modify: `packages/orchestrator/src/review.ts` only if `PrBranches` must carry `headSha` — prefer a separate type to avoid forcing CLI path changes

**Interfaces:**
- Consumes: `parsePrUrl`, `fetch`
- Produces:
  - `export type GithubPullDetails = { owner: string; repo: string; number: number; headSha: string; headRef: string; baseRef: string; filePaths: string[] }`
  - `export async function fetchGithubPullDetails(prUrl: string, opts: { token: string; fetchImpl?: typeof fetch }): Promise<GithubPullDetails>`
  - Keep `resolvePrBranchesViaGithub` working: implement it by calling `fetchGithubPullDetails` and mapping to `PrBranches` (ignore `filePaths`/`headSha` for that return type)

`fetchGithubPullDetails` must:

1. `GET /repos/{owner}/{repo}/pulls/{n}` → `head.sha`, `head.ref`, `base.ref`
2. `GET /repos/{owner}/{repo}/pulls/{n}/files?per_page=100` → collect `filename` (paginate only if `Link` rel=next present; builder may cap at first page of 100 for v1 and document it)

- [ ] **Step 1: Write the failing test**

```ts
it("fetchGithubPullDetails returns headSha and file paths", async () => {
  const fetchImpl = async (url: string) => {
    if (String(url).endsWith("/pulls/1")) {
      return new Response(JSON.stringify({ head: { ref: "feat", sha: "abc123" }, base: { ref: "main" } }), { status: 200 });
    }
    if (String(url).includes("/pulls/1/files")) {
      return new Response(JSON.stringify([{ filename: "src/A.cs" }, { filename: "src/B.cs" }]), { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  };
  const d = await fetchGithubPullDetails("https://github.com/acme/be/pull/1", { token: "t", fetchImpl });
  expect(d.headSha).toBe("abc123");
  expect(d.filePaths).toEqual(["src/A.cs", "src/B.cs"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/orchestrator test -- github-pr.test.ts -t fetchGithubPullDetails`  
Expected: FAIL (`fetchGithubPullDetails` not defined)

- [ ] **Step 3: Implement `fetchGithubPullDetails` and keep `resolvePrBranchesViaGithub` as a thin wrapper**

On non-OK responses, throw with status (same style as today).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @review/orchestrator test -- github-pr.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/github-pr.ts packages/orchestrator/tests/github-pr.test.ts
git commit -m "feat(orchestrator): fetch GitHub PR head SHA and file paths"
```

---

### Task 3: Markdown + inline mapping from `ReviewResult`

**Files:**
- Create: `packages/orchestrator/src/github-review-markdown.ts`
- Create: `packages/orchestrator/tests/github-review-markdown.test.ts`

**Interfaces:**
- Consumes: `ReviewResult`, `ReviewFinding`, `NO_FINDINGS_SUMMARY`, `GithubPullDetails` (`owner`, `repo`, `filePaths`)
- Produces:

```ts
export const GITHUB_REVIEW_MARKER_PREFIX = "<!-- review-orchestrator:reviewId=";
export function reviewIdMarker(reviewId: string): string; // full HTML comment
export type GithubInlineComment = {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "RIGHT";
};
export type GithubReviewPayload = {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: GithubInlineComment[];
};
export function buildGithubReviewPayload(
  result: ReviewResult,
  pull: Pick<GithubPullDetails, "owner" | "repo" | "headSha" | "filePaths">,
): GithubReviewPayload;
```

Eligibility helper (internal): path in `filePaths` after normalizing strip of leading `./`; `repo` omitted or equals `${owner}/${repo}` or equals `repo` alone when findings store short names — pin test to `${owner}/${repo}` and bare `repo` match.

Inline body: severity, title, evidence, suggestedAction when present.  
Review body must include `reviewIdMarker(result.reviewId)`.

- [ ] **Step 1: Write the failing tests**

```ts
it("empty findings uses NO_FINDINGS_SUMMARY and marker", () => { /* ... */ });
it("failed review includes error code and not NO_FINDINGS_SUMMARY", () => { /* ... */ });
it("inline only for matching repo + path in files + lineStart", () => { /* ... */ });
it("cross-repo finding stays body-only", () => { /* ... */ });
it("caps inline comments at 20", () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @review/orchestrator test -- github-review-markdown.test.ts`  
Expected: FAIL (module missing)

- [ ] **Step 3: Implement `buildGithubReviewPayload`**

For multi-line: if `lineEnd != null && lineEnd > lineStart`, set `start_line: lineStart`, `line: lineEnd`, `start_side: "RIGHT"`, `side: "RIGHT"`; else `line: lineStart` only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @review/orchestrator test -- github-review-markdown.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/github-review-markdown.ts packages/orchestrator/tests/github-review-markdown.test.ts
git commit -m "feat(orchestrator): map ReviewResult to GitHub COMMENT payload"
```

---

### Task 4: Idempotent `postPullRequestReview`

**Files:**
- Create: `packages/orchestrator/src/github-review.ts`
- Create: `packages/orchestrator/tests/github-review.test.ts`
- Modify: `packages/orchestrator/src/index.ts` (export public helpers if useful)

**Interfaces:**
- Consumes: `fetchGithubPullDetails`, `buildGithubReviewPayload`, `parsePrUrl`
- Produces:

```ts
export type GithubReviewPoster = {
  postReview(input: { prUrl: string; result: ReviewResult }): Promise<{ status: "created" | "skipped" }>;
};
export function createGithubReviewPoster(opts: {
  token: string;
  fetchImpl?: typeof fetch;
}): GithubReviewPoster;
```

Behavior:

1. `details = await fetchGithubPullDetails(...)`
2. `GET .../pulls/{n}/reviews` — if any `body` includes `reviewIdMarker(result.reviewId)` → return `{ status: "skipped" }`
3. `payload = buildGithubReviewPayload(result, details)`
4. `POST .../pulls/{n}/reviews` with JSON payload; on non-2xx throw `Error` whose `message` includes `github_delivery_failed` (worker maps by code string — prefer throwing an error with `code` property or message prefix `github_delivery_failed:`)

Pin: throw object usable as `error.code === "github_delivery_failed"` — use a small `export class GithubDeliveryError extends Error { code = "github_delivery_failed" as const }`.

- [ ] **Step 1: Write the failing tests**

```ts
it("creates COMMENT review with commit_id and marker", async () => { /* assert POST body.event === "COMMENT" */ });
it("skips when marker already present", async () => { /* GET reviews returns prior body with marker; expect no POST */ });
it("throws GithubDeliveryError on 500", async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @review/orchestrator test -- github-review.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement `createGithubReviewPoster`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @review/orchestrator test -- github-review.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/github-review.ts packages/orchestrator/tests/github-review.test.ts packages/orchestrator/src/index.ts
git commit -m "feat(orchestrator): post idempotent GitHub PR COMMENT reviews"
```

---

### Task 5: Wire worker delivery (GitHub then Teams)

**Files:**
- Modify: `packages/orchestrator/src/worker.ts`
- Modify: `packages/orchestrator/tests/worker.test.ts`
- Modify: `packages/orchestrator/src/teams-cli.ts`

**Interfaces:**
- Consumes: `GithubReviewPoster`, `AppConfig.githubReviewDelivery`
- Produces: updated `ReviewWorkerDeps`:

```ts
export type ReviewWorkerDeps = {
  // existing fields...
  githubReviewPoster?: GithubReviewPoster | null;
};
```

When `config.githubReviewDelivery` is true, `teams-cli` must pass `createGithubReviewPoster({ token: config.githubToken! })`. When false, omit / pass `null`.

Retryable set adds `"github_delivery_failed"`.

Per attempt after `runReview`:

```ts
let githubDelivered = false;
// inside loop:
if (deps.config.githubReviewDelivery && deps.githubReviewPoster && !githubDelivered) {
  try {
    await deps.githubReviewPoster.postReview({ prUrl, result: last });
    githubDelivered = true;
  } catch (err) {
    // map to last = { ...last, status: "failed", error: { code: "github_delivery_failed", message } }
  }
}
// then Teams reply as today; if Teams fails, do not clear githubDelivered
```

If GitHub failed this attempt, skip Teams for that attempt (job is already failed/retryable) — **pinned:** do not send a Teams success card for a delivery that will retry; only send Teams when GitHub succeeded or was skipped/disabled.

- [ ] **Step 1: Write the failing tests**

```ts
it("posts GitHub before Teams on completed review", async () => { /* order of mock calls */ });
it("skips GitHub when githubReviewDelivery false", async () => { /* poster not called */ });
it("retries github_delivery_failed without double post after success", async () => { /* first GitHub ok, Teams fails once, GitHub skipped second attempt */ });
it("does not call Teams when GitHub fails on an attempt", async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @review/orchestrator test -- worker.test.ts -t GitHub`  
Expected: FAIL

- [ ] **Step 3: Implement worker + teams-cli wiring**

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @review/orchestrator test -- worker.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/worker.ts packages/orchestrator/tests/worker.test.ts packages/orchestrator/src/teams-cli.ts
git commit -m "feat(orchestrator): deliver GitHub COMMENT review before Teams reply"
```

---

### Task 6: README + smoke note

**Files:**
- Modify: `README.md`
- Modify: `.env.example` if not fully covered in Task 1

**Interfaces:**
- Consumes: none new
- Produces: docs only

- [ ] **Step 1: Write README Phase 7 section**

Document: `COMMENT`-only reviews, marker idempotency, inline eligibility, `GITHUB_REVIEW_DELIVERY`, still Teams-primary, no approve/request-changes.

- [ ] **Step 2: Run unit suite for touched packages**

Run: `pnpm --filter @review/shared test && pnpm --filter @review/orchestrator test`  
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add README.md .env.example
git commit -m "docs: document GitHub review delivery (Phase 7)"
```

---

## Self-Review

1. **Spec coverage:** Design §6.1–6.6 → Tasks 2–5; config §6.6 → Task 1; module boundaries §7 → file structure; success criteria §9 → Review Focus tests + Task 5–6. Parent PRD non-goals (no approve/merge) → Global Constraints + COMMENT-only. Teams §5.8 preserved.
2. **Step scan:** Signatures, env defaults, marker string, retry code, ordering, and eligibility rules are pinned; markdown bullet prose left to builder.
3. **Type consistency:** `GithubPullDetails`, `GithubReviewPoster`, `github_delivery_failed`, `githubReviewDelivery`, `reviewIdMarker` align across tasks.
4. **Review Focus:** Each of the five bullets has an owning test (Tasks 3 and 5).
5. **Proportion:** Plan decides contracts and flow; does not transcript full GitHub API client.
