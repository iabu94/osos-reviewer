# Phase 1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a TypeScript monorepo that can accept a PR URL, resolve repos/branches/ticket ID, create isolated Git worktrees with a focused diff, invoke Claude Code headless with a stub MCP server, and clean up—without Teams, AST indexing, or RAG yet.

**Architecture:** A Node.js orchestrator owns the review lifecycle and Git worktrees. A separate MCP package exposes four stub tools over stdio so Claude Code can connect. PostgreSQL + pgvector is provisioned and health-checked; no symbol/document tables are populated in this phase. Configuration is file-based (repos, ticket pattern, worktree root, Claude CLI path).

**Tech Stack:** TypeScript (Node 22+), pnpm workspaces, Vitest, Zod, `@modelcontextprotocol/sdk`, `simple-git` (or `execa` + git CLI), PostgreSQL 16 + pgvector via Docker Compose, `pg` client.

**Spec:** `docs/superpowers/specs/2026-11-16-review-orchestrator-prd.md` (Phase 1 §10; Architecture Decision Summary §13)

## Global Constraints

- Review agent is Claude Code only; invoke via headless CLI (`claude -p`); no multi-model abstraction.
- Reviews are read-only: no source edits, commits, pushes, or merges.
- Ticket ID default pattern: `[A-Z]+-\d+`.
- Focused diff command equivalent: `git diff origin/<target>...HEAD -U2`.
- Orchestrator language: TypeScript/Node.js (call locked for this repo; PRD allowed Node or Python).
- Vector store: PostgreSQL + pgvector (schema for symbols/RAG deferred to later phases; Phase 1 only proves connectivity).
- MCP tools must not expose shell execution or unrestricted repo write access.
- Temporary worktrees must be cleaned up after success or failure.
- No Teams webhook, Adaptive Cards, AST parsers, or document RAG in this phase.

## Review Focus

- Duplicate concurrent reviews for the same PR must not share or corrupt the same worktree path — expect isolated paths keyed by review id.
- Missing companion branch must fall back to configured baseline (`origin/develop` or `origin/main`) and record that decision in review metadata — never silently pair unrelated branches.
- Unresolvable ticket ID must surface a structured failure (or configured fallback policy), not invent a ticket.
- Claude CLI failure / timeout must leave the review in a failed state and still run worktree cleanup.
- MCP stub tools must return bounded JSON with an explicit `no_results` vs `service_error` distinction even before real backends exist.

## Out of scope (later plans)

- Phase 2: Document RAG + `get_coding_standards` real retrieval
- Phase 3: .NET / Angular AST indexing
- Phase 4: Real MCP tool implementations
- Phase 5: Full review prompt + structured findings contract
- Phase 6: Teams bot, Adaptive Cards, auth, idempotency, observability hardening

---

## File Structure

```text
package.json                          # pnpm workspace root
pnpm-workspace.yaml
tsconfig.base.json
docker-compose.yml                    # postgres:16 + pgvector
.env.example
packages/
  shared/
    package.json
    src/
      config.ts                       # load/validate RepoConfig, AppConfig
      types.ts                        # ReviewRequest, ReviewMetadata, Finding stubs
      errors.ts                       # typed errors (TicketUnresolved, RepoUnknown, …)
      index.ts
  db/
    package.json
    src/
      client.ts                       # pool + healthCheck()
      migrate.ts                      # apply sql/001_extensions.sql
      sql/001_extensions.sql          # CREATE EXTENSION vector
      index.ts
  git-manager/
    package.json
    src/
      worktree.ts                     # create/cleanup worktrees
      diff.ts                         # focused diff
      companion.ts                    # ticket extract + companion branch resolve
      index.ts
    tests/
      companion.test.ts
      diff.test.ts
      worktree.test.ts
  mcp-server/
    package.json
    src/
      server.ts                       # MCP stdio server
      tools/
        stubs.ts                      # four stub tools
      index.ts
    tests/
      tools.test.ts
  orchestrator/
    package.json
    src/
      review.ts                       # runReview(request) lifecycle
      claude.ts                       # spawn claude -p with MCP config
      cli.ts                          # `review --pr-url …` local entry
      index.ts
    tests/
      review.test.ts
      claude.test.ts
fixtures/
  repos/                              # tiny git repos for integration tests (created in tasks)
knowledge-base/                       # empty placeholder dirs for Phase 2
  coding-standards/
  architecture/
  security/
```

---

### Task 1: Monorepo scaffold and shared config

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/{config,types,errors,index}.ts`
- Test: `packages/shared/src/config.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): AppConfig`
  - `AppConfig`: `{ databaseUrl, worktreeRoot, claudeCliPath, ticketPattern: RegExp, repos: RepoConfig[], companionFallbackBranch: string, reviewTimeoutMs: number }`
  - `RepoConfig`: `{ id: string, role: "backend" | "frontend", localPath: string, remoteUrl?: string, defaultBaseBranch: string }`
  - `ReviewRequest`: `{ prUrl: string, reviewId: string, teamsThreadRef?: string }`
  - Errors: `ConfigError`, `TicketUnresolvedError`, `UnknownRepositoryError`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("parses REPOS_JSON and default ticket pattern", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://review:review@localhost:5432/review",
      WORKTREE_ROOT: "/tmp/review-worktrees",
      CLAUDE_CLI_PATH: "claude",
      REPOS_JSON: JSON.stringify([
        {
          id: "be",
          role: "backend",
          localPath: "/repos/be",
          defaultBaseBranch: "develop",
        },
        {
          id: "fe",
          role: "frontend",
          localPath: "/repos/fe",
          defaultBaseBranch: "develop",
        },
      ]),
    });
    expect(cfg.ticketPattern.source).toBe("[A-Z]+-\\d+");
    expect(cfg.repos).toHaveLength(2);
    expect(cfg.companionFallbackBranch).toBe("origin/develop");
  });

  it("throws ConfigError when REPOS_JSON is missing", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://x", WORKTREE_ROOT: "/tmp" }),
    ).toThrow(/REPOS_JSON/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/abdullah/Projects/OSOS/cursor-review-platform && pnpm --filter @review/shared test -- config.test.ts`
Expected: FAIL (package / module not found)

- [ ] **Step 3: Implement scaffold + `loadConfig`**

Root `package.json` scripts: `test`, `build`, `typecheck`. Workspace packages named `@review/shared`, `@review/db`, `@review/git-manager`, `@review/mcp-server`, `@review/orchestrator`. Implement Zod-validated `loadConfig` with defaults: `ticketPattern = /[A-Z]+-\d+/`, `companionFallbackBranch = "origin/develop"`, `reviewTimeoutMs = 120_000`, `claudeCliPath = "claude"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @review/shared test -- config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git init  # if not already a git repo
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore .env.example packages/shared
git commit -m "chore: scaffold TypeScript monorepo and shared config"
```

---

### Task 2: PostgreSQL + pgvector health check

**Files:**
- Create: `docker-compose.yml`
- Create: `packages/db/package.json`, `packages/db/src/{client,migrate,index}.ts`, `packages/db/src/sql/001_extensions.sql`
- Test: `packages/db/src/client.test.ts`

**Interfaces:**
- Consumes: `AppConfig.databaseUrl` from `@review/shared`
- Produces:
  - `createPool(databaseUrl: string): Pool`
  - `healthCheck(pool: Pool): Promise<{ ok: true; vector: boolean }>`
  - `migrate(pool: Pool): Promise<void>` — applies `001_extensions.sql` (`CREATE EXTENSION IF NOT EXISTS vector`)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { createPool, healthCheck, migrate } from "./client.js";

const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb("db health", () => {
  it("connects and reports vector extension after migrate", async () => {
    const pool = createPool(url!);
    await migrate(pool);
    const result = await healthCheck(pool);
    expect(result).toEqual({ ok: true, vector: true });
    await pool.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose up -d && pnpm --filter @review/db test -- client.test.ts`
Expected: FAIL until client/migrate exist (or connection refused if compose not up)

- [ ] **Step 3: Implement Docker Compose + db package**

`docker-compose.yml` service `db` using image `pgvector/pgvector:pg16`, port `5432`, user/password/db `review`. Implement `createPool`, `migrate`, `healthCheck` (query `SELECT extname FROM pg_extension WHERE extname = 'vector'`).

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://review:review@localhost:5432/review pnpm --filter @review/db test -- client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml packages/db
git commit -m "feat: add PostgreSQL pgvector service and health check"
```

---

### Task 3: Ticket extraction and companion branch resolution

**Files:**
- Create: `packages/git-manager/package.json`, `packages/git-manager/src/companion.ts`, `packages/git-manager/src/index.ts`
- Test: `packages/git-manager/tests/companion.test.ts`

**Interfaces:**
- Consumes: `AppConfig.ticketPattern`, `AppConfig.companionFallbackBranch`, `RepoConfig`
- Produces:
  - `extractTicketId(text: string, pattern: RegExp): string | null`
  - `resolveCompanionBranch(input: { branches: string[]; ticketId: string | null; fallbackBranch: string }): { branch: string; usedFallback: boolean; reason: string }`
  - Throws `TicketUnresolvedError` when `ticketId` is null and policy is `require_ticket` (default for Phase 1)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { extractTicketId, resolveCompanionBranch } from "../src/companion.js";
import { TicketUnresolvedError } from "@review/shared";

describe("extractTicketId", () => {
  it("extracts Centroniz-style tickets from branch names", () => {
    expect(extractTicketId("feature/ABC-123-login", /[A-Z]+-\d+/)).toBe("ABC-123");
  });
  it("returns null when no ticket present", () => {
    expect(extractTicketId("feature/login", /[A-Z]+-\d+/)).toBeNull();
  });
});

describe("resolveCompanionBranch", () => {
  it("selects the branch containing the ticket id", () => {
    const r = resolveCompanionBranch({
      branches: ["origin/develop", "origin/feature/ABC-123-ui"],
      ticketId: "ABC-123",
      fallbackBranch: "origin/develop",
    });
    expect(r).toEqual({
      branch: "origin/feature/ABC-123-ui",
      usedFallback: false,
      reason: "ticket_match",
    });
  });

  it("falls back when no companion branch matches", () => {
    const r = resolveCompanionBranch({
      branches: ["origin/develop", "origin/feature/OTHER-1"],
      ticketId: "ABC-123",
      fallbackBranch: "origin/develop",
    });
    expect(r.usedFallback).toBe(true);
    expect(r.branch).toBe("origin/develop");
    expect(r.reason).toBe("no_ticket_branch");
  });

  it("throws when ticket is unresolved", () => {
    expect(() =>
      resolveCompanionBranch({
        branches: ["origin/develop"],
        ticketId: null,
        fallbackBranch: "origin/develop",
      }),
    ).toThrow(TicketUnresolvedError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/git-manager test -- companion.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `extractTicketId` and `resolveCompanionBranch`**

Matching rule: first remote branch whose short name includes the ticket id as a substring. If multiple match, pick the first lexicographically and set `reason: "ticket_match_ambiguous_first"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @review/git-manager test -- companion.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/git-manager
git commit -m "feat: extract ticket ids and resolve companion branches"
```

---

### Task 4: Worktree create/cleanup and focused diff

**Files:**
- Create: `packages/git-manager/src/worktree.ts`, `packages/git-manager/src/diff.ts`
- Test: `packages/git-manager/tests/worktree.test.ts`, `packages/git-manager/tests/diff.test.ts`
- Create: test helper that initializes disposable fixture repos under `fixtures/repos/`

**Interfaces:**
- Consumes: `AppConfig.worktreeRoot`
- Produces:
  - `createWorktree(opts: { repoPath: string; worktreeRoot: string; reviewId: string; repoId: string; branch: string }): Promise<{ worktreePath: string }>`
  - `removeWorktree(opts: { repoPath: string; worktreePath: string }): Promise<void>` — idempotent
  - `focusedDiff(opts: { worktreePath: string; targetBranch: string }): Promise<string>` — runs `git diff origin/<target>...HEAD -U2` with `origin/` stripped if already prefixed
  - Worktree path layout: `{worktreeRoot}/{reviewId}/{repoId}`

- [ ] **Step 1: Write the failing tests**

```ts
// worktree.test.ts — create two worktrees for same reviewId+different repoId; paths differ; removeWorktree twice does not throw
// diff.test.ts — commit a change on feature branch; focusedDiff against develop includes the changed file hunk and uses -U2 context
```

Pin assertions: path ends with `/{reviewId}/{repoId}`; after `removeWorktree`, path does not exist; second remove resolves; diff string contains the fixture filename `hello.txt`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @review/git-manager test -- worktree.test.ts diff.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement worktree + diff via git CLI**

Use `execa` (`git worktree add -B <branch> <path> --checkout` from existing local clone; for tests use bare+clone fixtures). Always `git worktree remove --force` then `fs.rm` if needed in `removeWorktree`. Exclude nothing in Phase 1 beyond what git already omits.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @review/git-manager test -- worktree.test.ts diff.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/git-manager fixtures
git commit -m "feat: manage isolated git worktrees and focused diffs"
```

---

### Task 5: MCP server skeleton with four stub tools

**Files:**
- Create: `packages/mcp-server/package.json`, `packages/mcp-server/src/{server,index}.ts`, `packages/mcp-server/src/tools/stubs.ts`
- Test: `packages/mcp-server/tests/tools.test.ts`

**Interfaces:**
- Consumes: none (stubs only)
- Produces:
  - Tools: `trace_fe_be_integration`, `trace_symbol_impact`, `check_reusability`, `get_coding_standards`
  - Each handler `(args: unknown) => Promise<McpToolResult>`
  - `McpToolResult`: `{ status: "ok" | "no_results" | "service_error"; data: unknown; error?: { code: string; message: string } }`
  - `startMcpServer(): Promise<void>` — stdio transport via `@modelcontextprotocol/sdk`
  - Stub `ok` payloads are empty arrays / empty rules with `status: "no_results"` when no backend wired; never pretend success with fake findings

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { handleTool } from "../src/tools/stubs.js";

describe("MCP stubs", () => {
  for (const name of [
    "trace_fe_be_integration",
    "trace_symbol_impact",
    "check_reusability",
    "get_coding_standards",
  ] as const) {
    it(`${name} returns no_results with bounded JSON`, async () => {
      const result = await handleTool(name, {});
      expect(result.status).toBe("no_results");
      expect(JSON.stringify(result).length).toBeLessThan(2_000);
    });
  }

  it("unknown tool returns service_error", async () => {
    const result = await handleTool("not_a_tool", {});
    expect(result.status).toBe("service_error");
    expect(result.error?.code).toBe("unknown_tool");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/mcp-server test -- tools.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement stub handlers + MCP server wiring**

Register all four tools with Zod input schemas (minimal: optional `query: string`, `repoIds: string[]`). Binary entry `node dist/index.js` for Claude MCP config. No shell tools.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @review/mcp-server test -- tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server
git commit -m "feat: add MCP server skeleton with four stub tools"
```

---

### Task 6: Claude Code headless runner

**Files:**
- Create: `packages/orchestrator/package.json`, `packages/orchestrator/src/claude.ts`
- Test: `packages/orchestrator/tests/claude.test.ts`

**Interfaces:**
- Consumes: `AppConfig.claudeCliPath`, `AppConfig.reviewTimeoutMs`, MCP server package path
- Produces:
  - `runClaudeReview(opts: { prompt: string; mcpServerCommand: string; mcpServerArgs: string[]; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>`
  - Spawns: `claude -p --output-format json` (adjust flags only if local CLI requires; document actual flags in code comment when verified)
  - Must pass MCP config that only allows the four review tools (via Claude MCP settings file written to a temp dir per review)
  - Does not pass write/commit permissions

- [ ] **Step 1: Write the failing test**

```ts
// Inject a fake CLI script via CLAUDE_CLI_PATH that writes argv to a file and prints {"ok":true}
// Assert runClaudeReview resolves with exitCode 0, timedOut false, and argv includes "-p"
// Second test: fake CLI sleeps past timeoutMs=50 → timedOut true
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/orchestrator test -- claude.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `runClaudeReview` with timeout + temp MCP config**

Use `AbortSignal` / `execa` timeout. Always remove temp MCP config dir in `finally`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @review/orchestrator test -- claude.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator
git commit -m "feat: invoke Claude Code headless with restricted MCP config"
```

---

### Task 7: Orchestrator `runReview` lifecycle + CLI

**Files:**
- Create: `packages/orchestrator/src/{review,cli,index}.ts`
- Test: `packages/orchestrator/tests/review.test.ts`
- Create: `knowledge-base/{coding-standards,architecture,security}/.gitkeep`

**Interfaces:**
- Consumes: shared config, git-manager, db healthCheck, `runClaudeReview`
- Produces:
  - `parsePrUrl(prUrl: string): { host: string; owner: string; repo: string; number: number }` — support GitHub-style `https://github.com/{owner}/{repo}/pull/{n}` for Phase 1; map `repo` to `RepoConfig.id` via config field `githubRepo?: string` added to `RepoConfig` if needed
  - `runReview(request: ReviewRequest, deps: ReviewDeps): Promise<ReviewResult>`
  - `ReviewResult`: `{ reviewId: string; status: "completed" | "failed"; metadata: ReviewMetadata; claudeStdout?: string; error?: { code: string; message: string } }`
  - `ReviewMetadata`: `{ primaryRepoId, primaryBranch, targetBranch, ticketId, companionRepoId, companionBranch, companionUsedFallback, companionReason, worktrees: string[], diffChars: number }`
  - Lifecycle: validate config → db healthCheck (warn/fail soft per `REQUIRE_DB=true`) → resolve PR/repo → extract ticket → create primary + companion worktrees → focused diff → runClaudeReview with prompt containing metadata + diff → cleanup worktrees in `finally` → return result
  - CLI: `pnpm --filter @review/orchestrator start -- --pr-url <url> [--review-id <id>]`

- [ ] **Step 1: Write the failing test**

Use fixture repos from Task 4. Assert:
1. Happy path `status === "completed"`, metadata has ticket + companion fields, worktree paths gone after return.
2. Missing ticket → `status === "failed"`, `error.code === "ticket_unresolved"`, no leftover worktrees.
3. Fake Claude timeout → `status === "failed"`, cleanup still ran.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @review/orchestrator test -- review.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `runReview` + CLI**

Prompt is a minimal Phase 1 string: PR metadata, diff, instruction to call MCP tools if needed, instruction not to modify files. Do not implement Teams delivery.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @review/orchestrator test -- review.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator knowledge-base
git commit -m "feat: orchestrate end-to-end local PR review lifecycle"
```

---

### Task 8: Root README and Phase 1 smoke script

**Files:**
- Create: `README.md`
- Create: `scripts/smoke-phase1.sh`
- Modify: root `package.json` (script `smoke:phase1`)

**Interfaces:**
- Consumes: docker compose, orchestrator CLI
- Produces: documented env vars and a smoke script that: starts db, runs migrations/health, runs unit tests, prints how to run a real `claude` review when CLI is installed

- [ ] **Step 1: Write smoke script that exits non-zero if `pnpm test` fails**

- [ ] **Step 2: Run `pnpm test` and `./scripts/smoke-phase1.sh`**

Expected: all unit tests PASS; smoke script exits 0 (Claude real invoke optional / skipped if `claude` missing)

- [ ] **Step 3: Write README with architecture diagram from PRD §4 trimmed to Phase 1 components**

- [ ] **Step 4: Commit**

```bash
git add README.md scripts/smoke-phase1.sh package.json
git commit -m "docs: add Phase 1 README and smoke script"
```

---

## Self-review notes

- Spec Phase 1 items map to tasks: orchestrator (7), Postgres/pgvector (2), repo config + worktrees (1,3,4), Claude headless (6), MCP skeleton (5).
- Teams, RAG, AST, real MCP logic explicitly deferred.
- Review Focus cases covered in Tasks 3, 4, 5, 7 tests.
