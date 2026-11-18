# GitHub Review Delivery Design

**Version:** 1.0  
**Status:** Draft (defaults chosen after partner opted out of brainstorming Q&A)  
**Phase:** 7 (add-on after Phase 6 Teams delivery)  
**Parent PRD:** `docs/superpowers/specs/2026-11-16-review-orchestrator-prd.md`

## 1. Intent

Engineers trigger reviews from Teams and already get an Adaptive Card reply. They also need the same findings on the GitHub pull request so reviewers who never open Teams still see the bot’s notes in the PR conversation and (where possible) next to the changed lines.

## 2. Goals

1. After a review finishes, post findings to the GitHub PR that was supplied in the Teams trigger.
2. Keep existing Teams Adaptive Card delivery unchanged and primary for the trigger thread.
3. Prefer inline comments when a finding points at a file/line on that PR; otherwise put the finding in the review summary body.
4. Never approve, request changes, merge, or close the PR.
5. Avoid duplicate GitHub posts when the worker retries delivery.

## 3. Non-Goals

- Posting to companion-repo PRs (only the trigger PR URL).
- Approving or requesting changes (`APPROVE` / `REQUEST_CHANGES`).
- Editing or deleting prior human comments.
- Replacing Teams delivery.
- GitHub Checks / status commits / Actions annotations.
- Multi-provider Git hosts (GitHub REST only, same as branch resolution).

## 4. Anti-Goals

- A “green” GitHub review that looks like approval when there are no findings.
- Silent GitHub failure while Teams succeeds with no log/retry signal.
- Dumping secrets, full Claude stdout, or raw MCP payloads into PR comments.

## 5. Constraints

- Same stack: TypeScript, pnpm workspaces, Vitest, existing `@review/orchestrator` worker.
- Auth: existing `GITHUB_TOKEN` (Bearer) with permission to create pull-request reviews on configured repos.
- Reviews remain read-only against git worktrees; posting comments is orchestrator-side HTTP only.
- Reuse `ReviewResult` / `ReviewReport` / `NO_FINDINGS_SUMMARY` / Adaptive Card truncation norms.
- Feature can be disabled without breaking Teams (`GITHUB_REVIEW_DELIVERY`).

## 6. Delivery Shape (decided)

### 6.1 API

One GitHub **Pull Request Review** per finished review job:

`POST /repos/{owner}/{repo}/pulls/{number}/reviews`

| Field | Value |
|-------|--------|
| `commit_id` | PR `head.sha` from GitHub (extend current PR lookup) |
| `event` | Always `COMMENT` |
| `body` | Markdown summary (see §6.3) |
| `comments` | Inline comments for eligible findings (see §6.2) |

Failed reviews (Claude/orchestrator failure, not GitHub itself) still post a **COMMENT** review whose body states failure `error.code` + short message — never `NO_FINDINGS_SUMMARY`.

### 6.2 Inline comments

A finding becomes an inline review comment when **all** of:

1. `filePath` is a non-empty string.
2. `lineStart` is a positive number.
3. The finding’s repo matches the trigger PR’s `owner/repo` when `repo` is set; if `repo` is omitted, treat as matching the trigger PR.
4. The path is present on the PR files list (`GET .../pulls/{n}/files`) so GitHub accepts the line comment.

Use GitHub’s multi-line comment fields when `lineEnd` is set and `lineEnd > lineStart`; otherwise single `line` = `lineStart`.

Findings that fail any rule stay in the review **body** only (grouped under “Other findings”).

Cap inline comments at **20** (same as Adaptive Card). Overflow findings remain in the body with an “N more findings omitted from inline comments” note.

### 6.3 Body markdown

**Completed with findings:**

```markdown
## Code review complete
<!-- review-orchestrator:reviewId=<reviewId> -->

<summary>

### Findings
- **[SEVERITY]** `category` — title (`path` or “no path”)
  - evidence one-liner / description
  - suggested action when present

### Other findings
(same bullets for non-inline items)

_N more findings omitted from inline comments_
```

**Completed with no findings:** body includes exact `NO_FINDINGS_SUMMARY` (and the HTML comment marker with `reviewId`).

**Failed:** title “Code review failed”, then `error.code` and `error.message`, plus the same `reviewId` marker.

### 6.4 Idempotency

Before creating a review, list recent reviews on the PR (`GET .../pulls/{n}/reviews`) and skip create if any review body contains `<!-- review-orchestrator:reviewId=<this reviewId> -->`.

Worker must not mark the job `completed` if GitHub delivery is required and failed after retries (same pattern as Teams).

### 6.5 Worker ordering and retries

Per attempt, after `runReview` returns:

1. Deliver GitHub (if `GITHUB_REVIEW_DELIVERY` enabled).
2. Deliver Teams Adaptive Card.

If GitHub throws → set `error.code = github_delivery_failed`, treat as retryable (add to retryable set with `teams_delivery_failed`, `claude_timeout`, `db_unhealthy`).

If GitHub succeeded earlier in a prior attempt (idempotent skip or stored success) and Teams fails → do not create a second GitHub review; only retry Teams.

**Builder call:** track in-memory per job `githubDelivered: boolean` for the attempt loop; combined with the HTML marker for cross-process/retry safety.

### 6.6 Config

| Env | Default | Meaning |
|-----|---------|---------|
| `GITHUB_TOKEN` | (already required for branch resolve in Teams path) | Auth for reviews API |
| `GITHUB_REVIEW_DELIVERY` | `true` when Teams server runs with GitHub token; `false` for local CLI-only unless set | Master switch |

CLI `runReview` without worker does **not** post to GitHub unless an explicit future flag is added (out of scope). Only the Teams worker path posts.

## 7. Module boundaries

| Unit | Responsibility |
|------|----------------|
| `packages/orchestrator/src/github-pr.ts` | Extend PR fetch to return `headSha`; optional `listPullFiles` |
| `packages/orchestrator/src/github-review.ts` | Build payload + `postPullRequestReview`; idempotent skip |
| `packages/orchestrator/src/github-review-markdown.ts` | Pure markdown/body + inline comment mapping from `ReviewResult` |
| `packages/orchestrator/src/worker.ts` | Call GitHub deliverer before Teams; retry codes |
| `packages/shared/src/config.ts` | `githubReviewDelivery: boolean` |

No new package. Tests use injectable `fetchImpl` (same as branch resolution).

## 8. Left to the builder

- Exact markdown spacing and bullet wording (must keep marker + `NO_FINDINGS_SUMMARY` exact).
- Whether to use `subject_type: "line"` / side `RIGHT` defaults required by current GitHub API.
- How to match `filePath` to PR file paths (normalize leading `./`, strip repo prefixes if present).
- Logging field names consistent with existing `createLogger` style.

## 9. Success criteria

- Completed review with file/line findings on the trigger PR → GitHub shows a COMMENT review with those inline notes + summary body; Teams card still sent.
- Cross-repo / no-line findings → appear only in the review body, not as failing API calls.
- Duplicate worker attempt with same `reviewId` → no second GitHub review.
- `GITHUB_REVIEW_DELIVERY=false` → Teams-only, no GitHub POST.
- Token never appears in review body or logs.

## 10. Calls made for the partner (defaults)

These were chosen after “skip” — change any before implementation if wrong:

1. **COMMENT-only** PR reviews (not issue comments-only, not Checks).
2. **Teams remains**; GitHub is additive.
3. **Inline when possible** on the trigger PR only; companion-repo paths stay in body.
4. **Failed reviews also COMMENT** on the PR with the error code.
5. **Delivery order:** GitHub then Teams; both retryable independently via shared attempt loop + idempotent GitHub marker.
6. **Worker-only** posting (not local CLI reviews).
