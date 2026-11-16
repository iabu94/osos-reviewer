import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  TicketUnresolvedError,
  UnknownRepositoryError,
  type AppConfig,
  type ReviewMetadata,
  type ReviewRequest,
  type ReviewResult,
} from "@review/shared";
import {
  createWorktree,
  extractTicketId,
  focusedDiff,
  removeWorktree,
  resolveCompanionBranch,
} from "@review/git-manager";
import { createPool, healthCheck, migrate } from "@review/db";
import { runClaudeReview } from "./claude.js";

const REVIEW_ID_RE = /^[A-Za-z0-9_-]+$/;

export type PrBranches = {
  primaryBranch: string;
  targetBranch: string;
  headRef: string;
};

export type ReviewDeps = {
  config: AppConfig;
  requireDb?: boolean;
  claudeCliPath: string;
  mcpServerCommand: string;
  mcpServerArgs: string[];
  getPrBranches: (prUrl: string) => Promise<PrBranches>;
  listRemoteBranches: (repoPath: string) => Promise<string[]>;
  runClaude?: typeof runClaudeReview;
  dbHealth?: (databaseUrl: string) => Promise<{ ok: true; vector: boolean }>;
};

export function parsePrUrl(prUrl: string): {
  host: string;
  owner: string;
  repo: string;
  number: number;
} {
  const match = prUrl.match(
    /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i,
  );
  if (!match) {
    throw new Error(`Unsupported PR URL: ${prUrl}`);
  }
  return {
    host: match[1]!,
    owner: match[2]!,
    repo: match[3]!,
    number: Number(match[4]),
  };
}

function findPrimaryRepo(config: AppConfig, owner: string, repo: string) {
  const githubRepo = `${owner}/${repo}`;
  const found = config.repos.find(
    (r) => r.githubRepo === githubRepo || r.id === repo,
  );
  if (!found) {
    throw new UnknownRepositoryError(`No configured repo for ${githubRepo}`);
  }
  return found;
}

function findCompanionRepo(config: AppConfig, primaryId: string) {
  const primary = config.repos.find((r) => r.id === primaryId)!;
  const companion = config.repos.find(
    (r) => r.id !== primaryId && r.role !== primary.role,
  );
  if (!companion) {
    throw new UnknownRepositoryError("No companion repository configured");
  }
  return companion;
}

async function defaultDbHealth(databaseUrl: string) {
  const pool = createPool(databaseUrl);
  try {
    await migrate(pool);
    return await healthCheck(pool);
  } finally {
    await pool.end();
  }
}

function buildPrompt(input: {
  request: ReviewRequest;
  metadata: ReviewMetadata;
  diff: string;
  primaryWorktree: string;
  companionWorktree: string;
}): string {
  return [
    "You are performing a read-only code review. Do not modify files, commit, push, or merge.",
    "Use MCP tools only when you need additional context.",
    "",
    `Review ID: ${input.request.reviewId}`,
    `PR URL: ${input.request.prUrl}`,
    `Primary worktree: ${input.primaryWorktree}`,
    `Companion worktree: ${input.companionWorktree}`,
    `Primary repo: ${input.metadata.primaryRepoId}`,
    `Primary branch: ${input.metadata.primaryBranch}`,
    `Primary HEAD: ${input.metadata.primaryHeadSha ?? "unknown"}`,
    `Target branch: ${input.metadata.targetBranch}`,
    `Ticket: ${input.metadata.ticketId}`,
    `Companion: ${input.metadata.companionRepoId} @ ${input.metadata.companionBranch} (fallback=${input.metadata.companionUsedFallback}, reason=${input.metadata.companionReason})`,
    "",
    "Focused diff:",
    input.diff,
  ].join("\n");
}

export async function runReview(
  request: ReviewRequest,
  deps: ReviewDeps,
): Promise<ReviewResult> {
  const worktrees: string[] = [];
  const created: Array<{ repoPath: string; worktreePath: string }> = [];
  let claimedReviewDir: string | null = null;

  const cleanup = async () => {
    for (const wt of created) {
      try {
        await removeWorktree(wt);
      } catch {
        // best-effort
      }
    }
    if (claimedReviewDir) {
      try {
        await rm(claimedReviewDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  };

  try {
    if (!REVIEW_ID_RE.test(request.reviewId)) {
      return {
        reviewId: request.reviewId,
        status: "failed",
        error: {
          code: "invalid_review_id",
          message: "reviewId must match ^[A-Za-z0-9_-]+$",
        },
      };
    }

    const reviewDir = join(deps.config.worktreeRoot, request.reviewId);
    try {
      await mkdir(reviewDir, { recursive: false });
      claimedReviewDir = reviewDir;
    } catch {
      return {
        reviewId: request.reviewId,
        status: "failed",
        error: {
          code: "review_id_in_use",
          message: `Review directory already exists: ${reviewDir}`,
        },
      };
    }

    if (deps.requireDb) {
      const check = deps.dbHealth ?? defaultDbHealth;
      const health = await check(deps.config.databaseUrl);
      if (!health.ok || !health.vector) {
        return {
          reviewId: request.reviewId,
          status: "failed",
          error: {
            code: "db_unhealthy",
            message: "Database health check failed",
          },
        };
      }
    }

    const parsed = parsePrUrl(request.prUrl);
    const primary = findPrimaryRepo(deps.config, parsed.owner, parsed.repo);
    const companion = findCompanionRepo(deps.config, primary.id);
    const branches = await deps.getPrBranches(request.prUrl);

    const ticketId = extractTicketId(
      branches.headRef,
      deps.config.ticketPattern,
    );
    if (!ticketId) {
      return {
        reviewId: request.reviewId,
        status: "failed",
        error: {
          code: "ticket_unresolved",
          message: "Ticket identifier could not be resolved",
        },
      };
    }

    const companionBranches = await deps.listRemoteBranches(
      companion.localPath,
    );
    let companionResolution: {
      branch: string;
      usedFallback: boolean;
      reason: string;
    };
    try {
      companionResolution = resolveCompanionBranch({
        branches: companionBranches,
        ticketId,
        fallbackBranch: deps.config.companionFallbackBranch,
      });
    } catch (err) {
      if (err instanceof TicketUnresolvedError) {
        return {
          reviewId: request.reviewId,
          status: "failed",
          error: { code: err.code, message: err.message },
        };
      }
      throw err;
    }

    const primaryWt = await createWorktree({
      repoPath: primary.localPath,
      worktreeRoot: deps.config.worktreeRoot,
      reviewId: request.reviewId,
      repoId: primary.id,
      branch: branches.primaryBranch,
    });
    created.push({
      repoPath: primary.localPath,
      worktreePath: primaryWt.worktreePath,
    });
    worktrees.push(primaryWt.worktreePath);

    const companionWt = await createWorktree({
      repoPath: companion.localPath,
      worktreeRoot: deps.config.worktreeRoot,
      reviewId: request.reviewId,
      repoId: companion.id,
      branch: companionResolution.branch,
    });
    created.push({
      repoPath: companion.localPath,
      worktreePath: companionWt.worktreePath,
    });
    worktrees.push(companionWt.worktreePath);

    const diff = await focusedDiff({
      worktreePath: primaryWt.worktreePath,
      targetBranch: branches.targetBranch,
    });

    const metadata: ReviewMetadata = {
      primaryRepoId: primary.id,
      primaryBranch: branches.primaryBranch,
      targetBranch: branches.targetBranch,
      ticketId,
      companionRepoId: companion.id,
      companionBranch: companionResolution.branch,
      companionUsedFallback: companionResolution.usedFallback,
      companionReason: companionResolution.reason,
      worktrees: [...worktrees],
      diffChars: diff.length,
      primaryHeadSha: primaryWt.headSha,
      companionHeadSha: companionWt.headSha,
    };

    const prompt = buildPrompt({
      request,
      metadata,
      diff,
      primaryWorktree: primaryWt.worktreePath,
      companionWorktree: companionWt.worktreePath,
    });
    const runClaude = deps.runClaude ?? runClaudeReview;
    const claude = await runClaude({
      prompt,
      claudeCliPath: deps.claudeCliPath,
      mcpServerCommand: deps.mcpServerCommand,
      mcpServerArgs: deps.mcpServerArgs,
      timeoutMs: deps.config.reviewTimeoutMs,
      cwd: primaryWt.worktreePath,
      addDirs: [companionWt.worktreePath],
    });

    if (claude.timedOut) {
      return {
        reviewId: request.reviewId,
        status: "failed",
        metadata,
        claudeStdout: claude.stdout,
        error: {
          code: "claude_timeout",
          message: claude.stderr || "Claude Code review timed out",
        },
      };
    }

    if (claude.exitCode !== 0) {
      return {
        reviewId: request.reviewId,
        status: "failed",
        metadata,
        claudeStdout: claude.stdout,
        error: {
          code: "claude_failed",
          message: claude.stderr || `Claude exited ${claude.exitCode}`,
        },
      };
    }

    return {
      reviewId: request.reviewId,
      status: "completed",
      metadata,
      claudeStdout: claude.stdout,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof UnknownRepositoryError
        ? err.code
        : err instanceof TicketUnresolvedError
          ? err.code
          : "review_error";
    return {
      reviewId: request.reviewId,
      status: "failed",
      error: { code, message },
    };
  } finally {
    try {
      await cleanup();
    } catch {
      // never throw from finally
    }
  }
}
