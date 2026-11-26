import {
  NO_FINDINGS_SUMMARY,
  type ReviewFinding,
  type ReviewResult,
} from "@osos-reviewer/shared";
import type { GithubPullDetails } from "./github-pr.js";

export const GITHUB_REVIEW_MARKER_PREFIX =
  "<!-- review-orchestrator:reviewId=";
export const MAX_INLINE_COMMENTS = 20;

export function reviewIdMarker(reviewId: string): string {
  return `${GITHUB_REVIEW_MARKER_PREFIX}${reviewId} -->`;
}

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

function normalizePath(filePath: string): string {
  return filePath.replace(/^\.\//, "");
}

function repoMatches(
  findingRepo: string | undefined,
  owner: string,
  repo: string,
): boolean {
  if (!findingRepo) {
    return true;
  }
  return (
    findingRepo === `${owner}/${repo}` ||
    findingRepo === repo
  );
}

function isInlineEligible(
  finding: ReviewFinding,
  pull: Pick<GithubPullDetails, "owner" | "repo" | "filePaths">,
): boolean {
  if (!finding.filePath) {
    return false;
  }
  if (finding.lineStart == null || finding.lineStart <= 0) {
    return false;
  }
  if (!repoMatches(finding.repo, pull.owner, pull.repo)) {
    return false;
  }
  const path = normalizePath(finding.filePath);
  return pull.filePaths.includes(path);
}

function inlineCommentBody(finding: ReviewFinding): string {
  const lines = [
    `**${finding.severity.toUpperCase()}** — ${finding.title}`,
    finding.evidence,
  ];
  if (finding.suggestedAction) {
    lines.push(`Suggested: ${finding.suggestedAction}`);
  }
  return lines.join("\n\n");
}

function toInlineComment(finding: ReviewFinding): GithubInlineComment {
  const path = normalizePath(finding.filePath!);
  const lineStart = finding.lineStart!;
  const base: GithubInlineComment = {
    path,
    line: lineStart,
    side: "RIGHT",
    body: inlineCommentBody(finding),
  };
  if (
    finding.lineEnd != null &&
    finding.lineEnd > lineStart
  ) {
    return {
      ...base,
      start_line: lineStart,
      line: finding.lineEnd,
      start_side: "RIGHT",
    };
  }
  return base;
}

function findingBullet(finding: ReviewFinding): string {
  const loc = finding.filePath
    ? `\`${normalizePath(finding.filePath)}\``
    : "no path";
  const parts = [
    `- **[${finding.severity.toUpperCase()}]** \`${finding.category}\` — ${finding.title} (${loc})`,
    `  - ${finding.evidence || finding.description}`,
  ];
  if (finding.suggestedAction) {
    parts.push(`  - ${finding.suggestedAction}`);
  }
  return parts.join("\n");
}

export function buildGithubReviewPayload(
  result: ReviewResult,
  pull: Pick<GithubPullDetails, "owner" | "repo" | "headSha" | "filePaths">,
): GithubReviewPayload {
  const marker = reviewIdMarker(result.reviewId);

  if (result.status === "failed") {
    const code = result.error?.code ?? "unknown_error";
    const message = result.error?.message ?? "An unknown error occurred.";
    return {
      commit_id: pull.headSha,
      event: "COMMENT",
      body: [
        "## Code review failed",
        marker,
        "",
        code,
        message,
      ].join("\n"),
      comments: [],
    };
  }

  const findings = result.report?.findings ?? [];
  if (findings.length === 0) {
    return {
      commit_id: pull.headSha,
      event: "COMMENT",
      body: [
        "## Code review complete",
        marker,
        "",
        NO_FINDINGS_SUMMARY,
      ].join("\n"),
      comments: [],
    };
  }

  const eligible = findings.filter((f) => isInlineEligible(f, pull));
  const inlineFindings = eligible.slice(0, MAX_INLINE_COMMENTS);
  const overflowCount = eligible.length - inlineFindings.length;
  const inlineSet = new Set(inlineFindings);
  const bodyOnly = findings.filter((f) => !inlineSet.has(f));

  const bodyParts = [
    "## Code review complete",
    marker,
    "",
    result.report?.summary ?? "",
    "",
    "### Findings",
    ...inlineFindings.map(findingBullet),
  ];

  if (bodyOnly.length > 0) {
    bodyParts.push("", "### Other findings", ...bodyOnly.map(findingBullet));
  }

  if (overflowCount > 0) {
    bodyParts.push(
      "",
      `${overflowCount} more findings omitted from inline comments`,
    );
  }

  return {
    commit_id: pull.headSha,
    event: "COMMENT",
    body: bodyParts.join("\n"),
    comments: inlineFindings.map(toInlineComment),
  };
}
