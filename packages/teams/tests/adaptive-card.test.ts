import { describe, expect, it } from "vitest";
import { NO_FINDINGS_SUMMARY } from "@osos-reviewer/shared";
import {
  buildReviewAdaptiveCard,
  CARD_CONTENT_TYPE,
  formatReviewCardTitle,
  OPEN_PR_ACTION_TITLE,
} from "../src/index.js";

const PR_URL = "https://github.com/pbsgears/ososerp-web/pull/6880";

describe("buildReviewAdaptiveCard", () => {
  it("matches compact PR review layout with Open GitHub review", () => {
    const card = buildReviewAdaptiveCard(
      {
        reviewId: "r",
        status: "completed",
        report: { summary: NO_FINDINGS_SUMMARY, findings: [] },
      },
      {
        prUrl: PR_URL,
        prTitle: "feat(UI): Tender Negotiation List & Initiation [CM-8995]",
        headSha: "f47f403abcdef",
      },
    );

    expect(card.contentType).toBe(CARD_CONTENT_TYPE);
    expect(card.content.version).toBe("1.4");
    expect(formatReviewCardTitle(PR_URL)).toBe(
      "AI review of pbsgears/ososerp-web#6880",
    );

    const texts = JSON.stringify(card.content);
    expect(texts).toContain("AI review of pbsgears/ososerp-web#6880");
    expect(texts).toContain(
      "feat(UI): Tender Negotiation List & Initiation [CM-8995]",
    );
    expect(texts).toContain('"title":"Head"');
    expect(texts).toContain("f47f403");
    expect(texts).toContain('"title":"Status"');
    expect(texts).toContain("Completed");
    expect(texts).toContain('"title":"Findings"');
    expect(texts).toContain("none");
    expect(texts).not.toContain(NO_FINDINGS_SUMMARY);
    expect(texts).not.toContain("Severity");

    expect(card.content.actions).toEqual([
      {
        type: "Action.OpenUrl",
        title: OPEN_PR_ACTION_TITLE,
        url: PR_URL,
      },
    ]);
  });

  it("shows findings count and prefers openUrl for the action", () => {
    const reviewUrl =
      "https://github.com/pbsgears/ososerp-web/pull/6880#pullrequestreview-1";
    const card = buildReviewAdaptiveCard(
      {
        reviewId: "r",
        status: "completed",
        report: {
          summary: "Auth token expiry is inconsistent across FE/BE.",
          findings: [
            {
              severity: "high",
              category: "security",
              title: "Token TTL mismatch",
              description: "Frontend assumes 1h; backend issues 15m.",
              evidence: "AuthService.refresh vs TokenService.Issue",
              confidence: "confirmed",
            },
            {
              severity: "low",
              category: "other",
              title: "Minor note",
              description: "n/a",
              evidence: "n/a",
              confidence: "potential",
            },
          ],
        },
      },
      { prUrl: PR_URL, openUrl: reviewUrl, headSha: "abc" },
    );

    const texts = JSON.stringify(card.content);
    expect(texts).toContain('"value":"2"');
    expect(texts).not.toContain("Token TTL mismatch");
    expect(card.content.actions).toEqual([
      {
        type: "Action.OpenUrl",
        title: OPEN_PR_ACTION_TITLE,
        url: reviewUrl,
      },
    ]);
  });

  it("failed card uses Failed status plus Error and Reason facts", () => {
    const card = buildReviewAdaptiveCard(
      {
        reviewId: "r",
        status: "failed",
        error: {
          code: "ticket_unresolved",
          message: "Ticket identifier could not be resolved",
        },
      },
      { prUrl: PR_URL, headSha: "deadbeef" },
    );
    const texts = JSON.stringify(card.content);
    expect(texts).toContain("AI review of pbsgears/ososerp-web#6880");
    expect(texts).toContain("Failed");
    expect(texts).toContain("ticket_unresolved");
    expect(texts).toContain('"title":"Reason"');
    expect(texts).toContain("Ticket identifier could not be resolved");
    expect(texts).toContain('"title":"Findings"');
    expect(texts).toContain("none");
    expect(card.content.actions?.[0]).toMatchObject({
      type: "Action.OpenUrl",
      title: OPEN_PR_ACTION_TITLE,
      url: PR_URL,
    });
  });
});
