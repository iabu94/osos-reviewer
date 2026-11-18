import type { ReviewResult } from "@review/shared";

export const CARD_SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";
export const CARD_TYPE = "AdaptiveCard";
export const CARD_VERSION = "1.4";
export const CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";
/** @deprecated Prefer card title built from the PR identity. */
export const FAILED_REVIEW_TITLE = "Code review failed";
/** @deprecated Prefer card title built from the PR identity. */
export const COMPLETED_REVIEW_TITLE = "Code review complete";
/** @deprecated Findings are delivered on the GitHub PR, not in the Teams card. */
export const MAX_FINDINGS_IN_CARD = 20;
export const OPEN_PR_ACTION_TITLE = "Open GitHub review";

export interface AdaptiveCard {
  $schema: typeof CARD_SCHEMA;
  type: typeof CARD_TYPE;
  version: typeof CARD_VERSION;
  body: unknown[];
  actions?: unknown[];
}

export type BuildReviewAdaptiveCardOpts = {
  prUrl: string;
  /** PR title shown under the card heading. */
  prTitle?: string;
  /** Full or abbreviated head SHA; shortened for display. */
  headSha?: string;
  /** Defaults to `prUrl`. Prefer the posted GitHub review URL when available. */
  openUrl?: string;
};

interface AdaptiveTextBlock {
  type: "TextBlock";
  text: string;
  weight?: "Bolder";
  wrap?: boolean;
  spacing?: "Medium" | "Small" | "None";
  size?: "Medium" | "Small";
  isSubtle?: boolean;
}

interface AdaptiveFact {
  title: string;
  value: string;
}

interface AdaptiveFactSet {
  type: "FactSet";
  facts: AdaptiveFact[];
  spacing?: "Medium";
}

interface AdaptiveOpenUrlAction {
  type: "Action.OpenUrl";
  title: string;
  url: string;
}

function textBlock(
  text: string,
  options?: Partial<Omit<AdaptiveTextBlock, "type" | "text">>,
): AdaptiveTextBlock {
  return { type: "TextBlock", text, wrap: true, ...options };
}

function parsePrIdentity(prUrl: string): {
  owner: string;
  repo: string;
  number: string;
} | null {
  const match = prUrl.match(
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?/i,
  );
  if (!match) {
    return null;
  }
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: match[3]!,
  };
}

export function formatReviewCardTitle(prUrl: string): string {
  const id = parsePrIdentity(prUrl);
  if (!id) {
    return "AI review";
  }
  return `AI review of ${id.owner}/${id.repo}#${id.number}`;
}

function shortSha(sha: string | undefined): string {
  if (!sha) {
    return "—";
  }
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function findingsLabel(result: ReviewResult): string {
  const count = result.report?.findings.length ?? 0;
  return count === 0 ? "none" : String(count);
}

function statusLabel(result: ReviewResult): string {
  return result.status === "completed" ? "Completed" : "Failed";
}

/**
 * Compact Teams card: PR identity, head/status/findings, Open GitHub review.
 * Detailed findings live on the GitHub PR review.
 */
export function buildReviewAdaptiveCard(
  result: ReviewResult,
  opts: BuildReviewAdaptiveCardOpts,
): {
  contentType: typeof CARD_CONTENT_TYPE;
  content: AdaptiveCard;
} {
  const body: unknown[] = [
    textBlock(formatReviewCardTitle(opts.prUrl), {
      weight: "Bolder",
      size: "Medium",
    }),
  ];

  if (opts.prTitle) {
    body.push(textBlock(opts.prTitle, { spacing: "Small" }));
  }

  const facts: AdaptiveFact[] = [
    { title: "Head", value: shortSha(opts.headSha) },
    { title: "Status", value: statusLabel(result) },
    { title: "Findings", value: findingsLabel(result) },
  ];

  if (result.status === "failed") {
    const code = result.error?.code;
    if (code) {
      facts.push({ title: "Error", value: code });
    }
  }

  const factSet: AdaptiveFactSet = {
    type: "FactSet",
    facts,
    spacing: "Medium",
  };
  body.push(factSet);

  const openUrl = opts.openUrl ?? opts.prUrl;
  const action: AdaptiveOpenUrlAction = {
    type: "Action.OpenUrl",
    title: OPEN_PR_ACTION_TITLE,
    url: openUrl,
  };

  return {
    contentType: CARD_CONTENT_TYPE,
    content: {
      $schema: CARD_SCHEMA,
      type: CARD_TYPE,
      version: CARD_VERSION,
      body,
      actions: [action],
    },
  };
}
