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

export type ReviewLifecycleStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed";

export interface TeamsConversationRef {
  serviceUrl: string;
  conversationId: string;
  activityId?: string;
  replyToId?: string;
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
  teams: {
    webhookSecret: string;
    /** Power Automate HTTP trigger URL for replies (Teams App path). */
    replyFlowUrl: string;
    botAppId: string;
    botPassword: string;
    port: number;
  };
  githubToken?: string;
  /** When true, Teams worker posts a COMMENT review to the trigger GitHub PR. */
  githubReviewDelivery: boolean;
  maxConcurrentReviews: number;
  reviewRetryMax: number;
}

export interface ReviewRequest {
  prUrl: string;
  reviewId: string;
  teamsConversationRef?: TeamsConversationRef;
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

export type FindingCategory =
  | "integration"
  | "reusability"
  | "symbol_impact"
  | "coding_standard"
  | "other";

export type FindingSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info";

export type FindingConfidence = "confirmed" | "potential";

export interface ReviewFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  title: string;
  description: string;
  evidence: string;
  repo?: string;
  filePath?: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  relatedSymbol?: string;
  relatedStandard?: string;
  suggestedAction?: string;
}

export interface ReviewReport {
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewDiagnostics {
  durationMs?: number;
  durationApiMs?: number;
  numTurns?: number;
  sessionId?: string;
  totalCostUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export const NO_FINDINGS_SUMMARY =
  "No actionable issues were identified by this review. This does not guarantee the pull request is defect-free.";

export interface ReviewResult {
  reviewId: string;
  status: "completed" | "failed";
  metadata?: ReviewMetadata;
  claudeStdout?: string;
  error?: { code: string; message: string };
  report?: ReviewReport;
  diagnostics?: ReviewDiagnostics;
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

export type IntegrationMismatchKind =
  | "missing_backend"
  | "missing_frontend"
  | "method_mismatch"
  | "shape_mismatch";

export interface SymbolEvidence {
  repo: string;
  symbolName: string;
  symbolType: SymbolType;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  signature: string;
}

export interface IntegrationMismatch {
  kind: IntegrationMismatchKind;
  summary: string;
  frontend?: SymbolEvidence;
  backend?: SymbolEvidence;
  detail?: {
    httpMethod?: string;
    path?: string;
    frontendProperties?: string[];
    backendProperties?: string[];
  };
}

export type ImpactedSymbol = SymbolEvidence & {
  via: RelationshipType | "seed";
  depth: number;
};

export type ReusabilityCandidate = SymbolEvidence & {
  score: number;
  explanation: string;
};

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
