import { NO_FINDINGS_SUMMARY, type ReviewFinding, type ReviewResult } from "@review/shared";

export const CARD_SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";
export const CARD_TYPE = "AdaptiveCard";
export const CARD_VERSION = "1.4";
export const CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";
export const FAILED_REVIEW_TITLE = "Code review failed";
export const COMPLETED_REVIEW_TITLE = "Code review complete";
export const MAX_FINDINGS_IN_CARD = 20;

export interface AdaptiveCard {
  $schema: typeof CARD_SCHEMA;
  type: typeof CARD_TYPE;
  version: typeof CARD_VERSION;
  body: unknown[];
}

interface AdaptiveTextBlock {
  type: "TextBlock";
  text: string;
  weight?: "Bolder";
  wrap?: boolean;
  spacing?: "Medium" | "Small";
  size?: "Medium";
}

interface AdaptiveFact {
  title: string;
  value: string;
}

interface AdaptiveFactSet {
  type: "FactSet";
  facts: AdaptiveFact[];
}

interface AdaptiveContainer {
  type: "Container";
  items: unknown[];
  separator?: boolean;
  spacing?: "Medium";
}

function textBlock(
  text: string,
  options?: Partial<Omit<AdaptiveTextBlock, "type" | "text">>,
): AdaptiveTextBlock {
  return { type: "TextBlock", text, wrap: true, ...options };
}

function findingContainer(finding: ReviewFinding): AdaptiveContainer {
  const facts: AdaptiveFact[] = [
    { title: "Severity", value: finding.severity.toUpperCase() },
    { title: "Category", value: finding.category },
    { title: "Title", value: finding.title },
    { title: "Evidence", value: finding.evidence },
  ];

  if (finding.filePath) {
    const linePart =
      finding.lineStart != null
        ? finding.lineEnd != null && finding.lineEnd !== finding.lineStart
          ? ` (lines ${finding.lineStart}–${finding.lineEnd})`
          : ` (line ${finding.lineStart})`
        : "";
    facts.push({
      title: "Location",
      value: `${finding.filePath}${linePart}`,
    });
  }

  const factSet: AdaptiveFactSet = { type: "FactSet", facts };
  return {
    type: "Container",
    separator: true,
    spacing: "Medium",
    items: [factSet],
  };
}

function buildFailedBody(result: ReviewResult): unknown[] {
  const code = result.error?.code ?? "unknown_error";
  const message = result.error?.message ?? "An unknown error occurred.";
  return [
    textBlock(FAILED_REVIEW_TITLE, { weight: "Bolder", size: "Medium" }),
    textBlock(code),
    textBlock(message),
  ];
}

function buildCompletedBody(result: ReviewResult): unknown[] {
  const report = result.report ?? { summary: "", findings: [] };
  const body: unknown[] = [
    textBlock(COMPLETED_REVIEW_TITLE, { weight: "Bolder", size: "Medium" }),
  ];

  if (report.findings.length === 0) {
    body.push(textBlock(NO_FINDINGS_SUMMARY));
    return body;
  }

  body.push(textBlock(report.summary));

  const visible = report.findings.slice(0, MAX_FINDINGS_IN_CARD);
  for (const finding of visible) {
    body.push(findingContainer(finding));
  }

  const omitted = report.findings.length - visible.length;
  if (omitted > 0) {
    body.push(
      textBlock(`${omitted} more findings omitted`, { spacing: "Small" }),
    );
  }

  return body;
}

export function buildReviewAdaptiveCard(result: ReviewResult): {
  contentType: typeof CARD_CONTENT_TYPE;
  content: AdaptiveCard;
} {
  const body =
    result.status === "failed"
      ? buildFailedBody(result)
      : buildCompletedBody(result);

  return {
    contentType: CARD_CONTENT_TYPE,
    content: {
      $schema: CARD_SCHEMA,
      type: CARD_TYPE,
      version: CARD_VERSION,
      body,
    },
  };
}