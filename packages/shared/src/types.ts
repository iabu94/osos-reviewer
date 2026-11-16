export type RepoRole = "backend" | "frontend";

export interface RepoConfig {
  id: string;
  role: RepoRole;
  localPath: string;
  remoteUrl?: string;
  defaultBaseBranch: string;
  githubRepo?: string;
}

export interface AppConfig {
  databaseUrl: string;
  worktreeRoot: string;
  claudeCliPath: string;
  ticketPattern: RegExp;
  repos: RepoConfig[];
  companionFallbackBranch: string;
  reviewTimeoutMs: number;
}

export interface ReviewRequest {
  prUrl: string;
  reviewId: string;
  teamsThreadRef?: string;
}

export interface ReviewMetadata {
  primaryRepoId: string;
  primaryBranch: string;
  targetBranch: string;
  ticketId: string;
  companionRepoId: string;
  companionBranch: string;
  companionUsedFallback: boolean;
  companionReason: string;
  worktrees: string[];
  diffChars: number;
}

export interface ReviewResult {
  reviewId: string;
  status: "completed" | "failed";
  metadata?: ReviewMetadata;
  claudeStdout?: string;
  error?: { code: string; message: string };
}
