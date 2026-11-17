import { describe, it, expect, afterEach, vi } from "vitest";
import { access, chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureRepo } from "../../git-manager/tests/fixture-repo.js";
import { loadConfig, NO_FINDINGS_SUMMARY, type AppConfig } from "@review/shared";
import { runReview, parsePrUrl } from "../src/review.js";
import type { ReviewDeps } from "../src/review.js";

function fixturePath(name: string): string {
  return fileURLToPath(
    new URL(`../fixtures/claude/${name}`, import.meta.url),
  );
}

async function makeFakeClaude(scriptBody: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rev-claude-"));
  const path = join(dir, "claude");
  await writeFile(path, `#!/bin/sh\n${scriptBody}\n`);
  await chmod(path, 0o755);
  return path;
}

async function makeFakeClaudeFixture(fixtureName: string): Promise<string> {
  const fp = fixturePath(fixtureName);
  return makeFakeClaude(`cat '${fp}'`);
}

describe("parsePrUrl", () => {
  it("parses GitHub PR URLs", () => {
    expect(
      parsePrUrl("https://github.com/acme/backend/pull/42"),
    ).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "backend",
      number: 42,
    });
  });
});

describe("runReview", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  async function setupPair(): Promise<{
    be: { repoPath: string };
    fe: { repoPath: string };
    config: AppConfig;
    worktreeRoot: string;
  }> {
    const be = await createFixtureRepo();
    const fe = await createFixtureRepo();
    cleanups.push(be.cleanup, fe.cleanup);
    const worktreeRoot = await mkdtemp(join(tmpdir(), "orch-wt-"));
    cleanups.push(async () =>
      rm(worktreeRoot, { recursive: true, force: true }),
    );

    const config = loadConfig({
      DATABASE_URL: "postgres://review:review@localhost:5433/review",
      WORKTREE_ROOT: worktreeRoot,
      CLAUDE_CLI_PATH: "claude",
      EMBEDDING_PROVIDER: "fake",
      REPOS_JSON: JSON.stringify([
        {
          id: "be",
          role: "backend",
          localPath: be.repoPath,
          defaultBaseBranch: "develop",
          githubRepo: "acme/backend",
        },
        {
          id: "fe",
          role: "frontend",
          localPath: fe.repoPath,
          defaultBaseBranch: "develop",
          githubRepo: "acme/frontend",
        },
      ]),
    });

    return { be, fe, config, worktreeRoot };
  }

  function baseDeps(
    config: AppConfig,
    claudePath: string,
    headRef: string,
  ): ReviewDeps {
    return {
      config,
      requireDb: false,
      claudeCliPath: claudePath,
      mcpServerCommand: "echo",
      mcpServerArgs: ["mcp"],
      getPrBranches: async () => ({
        primaryBranch: headRef,
        targetBranch: "develop",
        headRef,
      }),
      listRemoteBranches: async (repoPath) => {
        const { execa } = await import("execa");
        const { stdout } = await execa("git", ["branch", "-r"], {
          cwd: repoPath,
        });
        return stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
      },
    };
  }

  it("completes happy path and cleans worktrees", async () => {
    const { config, worktreeRoot } = await setupPair();
    const claude = await makeFakeClaudeFixture("success-no-findings.json");
    const result = await runReview(
      {
        prUrl: "https://github.com/acme/backend/pull/1",
        reviewId: "rev-happy",
      },
      baseDeps(config, claude, "feature/ABC-123"),
    );

    expect(result.status).toBe("completed");
    expect(result.report?.findings).toEqual([]);
    expect(result.metadata?.ticketId).toBe("ABC-123");
    expect(result.metadata?.companionRepoId).toBe("fe");
    expect(result.metadata?.companionBranch).toBeTruthy();
    expect(result.metadata?.diffChars).toBeGreaterThan(0);

    await expect(
      access(join(worktreeRoot, "rev-happy")),
    ).rejects.toThrow();
  });

  it("fails on unresolved ticket and cleans worktrees", async () => {
    const { config, worktreeRoot } = await setupPair();
    const claude = await makeFakeClaudeFixture("success-no-findings.json");
    const result = await runReview(
      {
        prUrl: "https://github.com/acme/backend/pull/2",
        reviewId: "rev-noticket",
      },
      baseDeps(config, claude, "feature/no-ticket"),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ticket_unresolved");
    await expect(
      access(join(worktreeRoot, "rev-noticket")),
    ).rejects.toThrow();
  });

  it("fails on Claude timeout and still cleans worktrees", async () => {
    const { config, worktreeRoot } = await setupPair();
    const claude = await makeFakeClaude(`sleep 2\necho ok`);
    const deps = baseDeps(config, claude, "feature/ABC-123");
    deps.config = { ...config, reviewTimeoutMs: 50 };

    const result = await runReview(
      {
        prUrl: "https://github.com/acme/backend/pull/3",
        reviewId: "rev-timeout",
      },
      deps,
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("claude_timeout");
    await expect(
      access(join(worktreeRoot, "rev-timeout")),
    ).rejects.toThrow();
  });

  it("rejects unsafe reviewId before creating worktrees", async () => {
    const { config, worktreeRoot } = await setupPair();
    const claude = await makeFakeClaude(`echo ok`);
    const result = await runReview(
      {
        prUrl: "https://github.com/acme/backend/pull/4",
        reviewId: "..",
      },
      baseDeps(config, claude, "feature/ABC-123"),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_review_id");
    await expect(access(join(worktreeRoot, ".."))).resolves.toBeUndefined();
  });

  it("records companion fallback when no ticket branch exists", async () => {
    const { config } = await setupPair();
    const claude = await makeFakeClaudeFixture("success-no-findings.json");
    const deps = baseDeps(config, claude, "feature/ABC-123");
    deps.listRemoteBranches = async () => ["origin/develop"];
    const result = await runReview(
      {
        prUrl: "https://github.com/acme/backend/pull/5",
        reviewId: "rev-fallback",
      },
      deps,
    );
    expect(result.status).toBe("completed");
    expect(result.metadata?.companionUsedFallback).toBe(true);
    expect(result.metadata?.companionReason).toBe("no_ticket_branch");
    expect(result.metadata?.companionBranch).toBe("origin/develop");
  });

  function mockPoolDeps() {
    const pool = { end: vi.fn(async () => undefined) };
    const indexPrDelta = vi.fn(async () => ({
      filesConsidered: 1,
      filesParsed: 1,
      filesDeleted: 0,
      symbolsUpserted: 2,
      filesFailed: 0,
    }));
    const cleanupPrIndex = vi.fn(async () => ({ symbolsDeleted: 2 }));
    return {
      pool,
      indexPrDelta,
      cleanupPrIndex,
      dbPoolFactory: () => pool as never,
      dbHealth: async () => ({ ok: true as const, vector: true }),
    };
  }

  it("runs PR delta indexing and cleans up PR index", async () => {
    const { config } = await setupPair();
    const claude = await makeFakeClaudeFixture("success-no-findings.json");
    const mocks = mockPoolDeps();
    const request = {
      prUrl: "https://github.com/acme/backend/pull/6",
      reviewId: "rev-index",
    };
    const result = await runReview(request, {
      ...baseDeps(config, claude, "feature/ABC-123"),
      requireDb: true,
      ...mocks,
    });

    expect(result.status).toBe("completed");
    expect(mocks.indexPrDelta).toHaveBeenCalledTimes(2);
    const calls = mocks.indexPrDelta.mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(calls.map((c) => c.repoId).sort()).toEqual(["be", "fe"]);
    for (const c of calls) {
      expect(c.reviewId).toBe(request.reviewId);
      expect(c.rootDir).toBe(c.worktreePath);
    }
    expect(mocks.cleanupPrIndex).toHaveBeenCalledWith(
      mocks.pool,
      request.reviewId,
    );
    expect(mocks.pool.end).toHaveBeenCalled();
  });

  it("cleans up PR index when Claude fails", async () => {
    const { config } = await setupPair();
    const claude = await makeFakeClaude(`exit 1`);
    const mocks = mockPoolDeps();
    const result = await runReview(
      {
        prUrl: "https://github.com/acme/backend/pull/7",
        reviewId: "rev-claude-fail",
      },
      {
        ...baseDeps(config, claude, "feature/ABC-123"),
        requireDb: true,
        ...mocks,
      },
    );
    expect(result.error?.code).toBe("claude_failed");
    expect(mocks.cleanupPrIndex).toHaveBeenCalledWith(
      mocks.pool,
      "rev-claude-fail",
    );
  });

  it("fails with index_failed and still cleans up", async () => {
    const { config, worktreeRoot } = await setupPair();
    const claude = await makeFakeClaude(`echo ok`);
    const mocks = mockPoolDeps();
    mocks.indexPrDelta.mockRejectedValueOnce(new Error("boom"));
    const result = await runReview(
      {
        prUrl: "https://github.com/acme/backend/pull/8",
        reviewId: "rev-index-fail",
      },
      {
        ...baseDeps(config, claude, "feature/ABC-123"),
        requireDb: true,
        ...mocks,
      },
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("index_failed");
    expect(mocks.cleanupPrIndex).toHaveBeenCalledWith(
      mocks.pool,
      "rev-index-fail",
    );
    await expect(
      access(join(worktreeRoot, "rev-index-fail")),
    ).rejects.toThrow();
  });

  it("completed review attaches structured report from Claude stdout", async () => {
    const { config } = await setupPair();
    const claude = await makeFakeClaudeFixture("success-finding.json");
    const result = await runReview(
      {
        prUrl: "https://github.com/acme/backend/pull/9",
        reviewId: "rev-report",
      },
      baseDeps(config, claude, "feature/ABC-123"),
    );
    expect(result.status).toBe("completed");
    expect(result.report?.findings[0]?.category).toBe("integration");
    expect(result.diagnostics?.inputTokens).toBe(100);
  });

  it("missing structured_output fails with invalid_review_output", async () => {
    const { config } = await setupPair();
    const claude = await makeFakeClaudeFixture("missing-structured-output.json");
    const result = await runReview(
      {
        prUrl: "https://github.com/acme/backend/pull/10",
        reviewId: "rev-missing-structured",
      },
      baseDeps(config, claude, "feature/ABC-123"),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_review_output");
  });

  it("empty findings completes with NO_FINDINGS_SUMMARY", async () => {
    const { config } = await setupPair();
    const claude = await makeFakeClaudeFixture("success-no-findings.json");
    const result = await runReview(
      {
        prUrl: "https://github.com/acme/backend/pull/11",
        reviewId: "rev-no-findings",
      },
      baseDeps(config, claude, "feature/ABC-123"),
    );
    expect(result.status).toBe("completed");
    expect(result.report?.findings).toEqual([]);
    expect(result.report?.summary).toBe(NO_FINDINGS_SUMMARY);
  });
});
