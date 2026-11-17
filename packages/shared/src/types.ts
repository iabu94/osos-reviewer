export type RepoRole = "backend" | "frontend";

export type DocumentCategory =
  | "coding-standards"
  | "architecture"
  | "security";

export type DocumentTechnology =
  | "angular"
  | "dotnet"
  | "database"
  | "general";

export interface EmbeddingConfig {
  provider: "openai_compatible" | "fake";
  baseUrl?: string;
  apiKey?: string;
  model: string;
  dimensions: 768;
}

export interface CodingStandardRule {
  ruleText: string;
  documentPath: string;
  documentTitle: string;
  section: string;
  category: DocumentCategory;
  technology: DocumentTechnology;
  score: number;
}

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
  knowledgeBasePath: string;
  embedding: EmbeddingConfig;
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
  primaryHeadSha?: string;
  companionHeadSha?: string;
}

export interface ReviewResult {
  reviewId: string;
  status: "completed" | "failed";
  metadata?: ReviewMetadata;
  claudeStdout?: string;
  error?: { code: string; message: string };
}

export type SymbolType =
  | "controller"
  | "endpoint"
  | "dto"
  | "service_method"
  | "validation_rule"
  | "entity"
  | "dbcontext_config"
  | "angular_service"
  | "http_call"
  | "interface"
  | "component"
  | "signal";

export type RelationshipType =
  | "calls"
  | "references"
  | "implements"
  | "maps_to"
  | "exposes"
  | "http_calls"
  | "validates"
  | "injects";

export type IndexScope = "baseline" | "pr";

export interface CodeSymbolRecord {
  id: number;
  repo: string;
  revision: string;
  branchTag: string | null;
  indexScope: IndexScope;
  reviewId: string | null;
  symbolType: SymbolType;
  symbolName: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  signature: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  commitSha: string;
  contentHash: string;
}

export interface CodeRelationshipRecord {
  id: number;
  repo: string;
  indexScope: IndexScope;
  reviewId: string | null;
  commitSha: string;
  sourceSymbolId: number;
  targetSymbolId: number | null;
  targetName: string | null;
  relationshipType: RelationshipType;
  filePath: string | null;
  lineStart: number | null;
}
