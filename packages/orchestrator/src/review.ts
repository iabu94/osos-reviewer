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
import { cleanupPrIndex, indexPrDelta } from "@review/code-intel";
import { createEmbeddingProvider } from "@review/knowledge";
import { runClaudeReview } from "./claude.js";
import { parseClaudeReviewOutput } from "./parse-claude.js";
import { buildReviewPrompt } from "./prompt.js";

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
  indexPrDelta?: typeof indexPrDelta;
  cleanupPrIndex?: typeof cleanupPrIndex;
  dbPoolFactory?: (url: string) => ReturnType<typeof createPool>;
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

function repoIdsByRole(config: AppConfig, role: "backend" | "frontend"): string[] {
  return config.repos.filter((r) => r.role === role).map((r) => r.id);
}

function tryDiagnosticsFromStdout(stdout: string) {
  const parsed = parseClaudeReviewOutput(stdout);
  return parsed.diagnostics;
}

export async function runReview(
  request: ReviewRequest,
  deps: ReviewDeps,
): Promise<ReviewResult> {
  const worktrees: string[] = [];
  const created: Array<{ repoPath: string; worktreePath: string }> = [];
  let claimedReviewDir: string | null = null;
  let pool: ReturnType<typeof createPool> | null = null;

  const cleanup = async () => {
    if (pool) {
      const usedPool = pool;
      pool = null;
      try {
        await (deps.cleanupPrIndex ?? cleanupPrIndex)(
          usedPool,
          request.reviewId,
        );
      } catch {
        // best-effort
      }
      try {
        await usedPool.end();
      } catch {
        // best-effort
      }
    }
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

    if (deps.requireDb) {
      pool = (deps.dbPoolFactory ?? createPool)(deps.config.databaseUrl);
      const index = deps.indexPrDelta ?? indexPrDelta;
      const embedder = createEmbeddingProvider(deps.config.embedding);
      const targets = [
        {
          repo: primary,
          worktreePath: primaryWt.worktreePath,
          headSha: primaryWt.headSha,
          branchTag: branches.primaryBranch,
          targetBranch: branches.targetBranch,
        },
        {
          repo: companion,
          worktreePath: companionWt.worktreePath,
          headSha: companionWt.headSha,
          branchTag: companionResolution.branch,
          targetBranch: companion.defaultBaseBranch,
        },
      ];
      try {
        for (const t of targets) {
          await index({
            pool,
            repoId: t.repo.id,
            reviewId: request.reviewId,
            commitSha: t.headSha,
            branchTag: t.branchTag,
            rootDir: t.worktreePath,
            worktreePath: t.worktreePath,
            targetBranch: t.targetBranch,
            role: t.repo.role,
            embedder,
          });
        }
      } catch (err) {
        return {
          reviewId: request.reviewId,
          status: "failed",
          error: {
            code: "index_failed",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }

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

    const prompt = buildReviewPrompt({
      request,
      metadata,
      diff,
      primaryWorktree: primaryWt.worktreePath,
      companionWorktree: companionWt.worktreePath,
      backendRepoIds: repoIdsByRole(deps.config, "backend"),
      frontendRepoIds: repoIdsByRole(deps.config, "frontend"),
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
        diagnostics: tryDiagnosticsFromStdout(claude.stdout),
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
        diagnostics: tryDiagnosticsFromStdout(claude.stdout),
        error: {
          code: "claude_failed",
          message: claude.stderr || `Claude exited ${claude.exitCode}`,
        },
      };
    }

    const claudeOutput = parseClaudeReviewOutput(claude.stdout);
    if (!claudeOutput.ok) {
      return {
        reviewId: request.reviewId,
        status: "failed",
        metadata,
        claudeStdout: claude.stdout,
        diagnostics: claudeOutput.diagnostics,
        error: {
          code:
            claudeOutput.code === "claude_envelope_error"
              ? "claude_failed"
              : "invalid_review_output",
          message: claudeOutput.message,
        },
      };
    }

    return {
      reviewId: request.reviewId,
      status: "completed",
      metadata,
      claudeStdout: claude.stdout,
      report: claudeOutput.report,
      diagnostics: claudeOutput.diagnostics,
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
