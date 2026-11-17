import { describe, expect, it } from "vitest";
import { NO_FINDINGS_SUMMARY } from "@review/shared";
import {
  buildReviewAdaptiveCard,
  CARD_CONTENT_TYPE,
  FAILED_REVIEW_TITLE,
} from "../src/index.js";

describe("buildReviewAdaptiveCard", () => {
  it("no-findings card uses NO_FINDINGS_SUMMARY", () => {
    const card = buildReviewAdaptiveCard({
      reviewId: "r",
      status: "completed",
      report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
    });
    expect(card.contentType).toBe(CARD_CONTENT_TYPE);
    expect(card.content.version).toBe("1.4");
    const texts = JSON.stringify(card.content.body);
    expect(texts).toContain(NO_FINDINGS_SUMMARY);
    expect(texts).not.toContain(FAILED_REVIEW_TITLE);
  });

  it("failed card surfaces error code and omits NO_FINDINGS_SUMMARY", () => {
    const card = buildReviewAdaptiveCard({
      reviewId: "r",
      status: "failed",
      error: { code: "claude_timeout", message: "timed out" },
    });
    const texts = JSON.stringify(card.content.body);
    expect(texts).toContain("claude_timeout");
    expect(texts).toContain(FAILED_REVIEW_TITLE);
    expect(texts).not.toContain(NO_FINDINGS_SUMMARY);
  });
});