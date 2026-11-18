import { describe, expect, it } from "vitest";
import { NO_FINDINGS_SUMMARY, type ReviewFinding } from "@review/shared";
import {
  buildGithubReviewPayload,
  reviewIdMarker,
} from "../src/github-review-markdown.js";

const pull = {
  owner: "acme",
  repo: "be",
  headSha: "abc123",
  filePaths: ["src/A.cs", "src/B.cs"],
};

function finding(partial: Partial<ReviewFinding>): ReviewFinding {
  return {
    category: "other",
    severity: "medium",
    confidence: "confirmed",
    title: "t",
    description: "d",
    evidence: "e",
    ...partial,
  };
}

describe("buildGithubReviewPayload", () => {
  it("empty findings uses NO_FINDINGS_SUMMARY and marker", () => {
    const payload = buildGithubReviewPayload(
      {
        reviewId: "rev1",
        status: "completed",
        report: { summary: "ignored", findings: [] },
      },
      pull,
    );
    expect(payload.event).toBe("COMMENT");
    expect(payload.commit_id).toBe("abc123");
    expect(payload.body).toContain(NO_FINDINGS_SUMMARY);
    expect(payload.body).toContain(reviewIdMarker("rev1"));
    expect(payload.comments).toEqual([]);
  });

  it("failed review includes error code and not NO_FINDINGS_SUMMARY", () => {
    const payload = buildGithubReviewPayload(
      {
        reviewId: "rev2",
        status: "failed",
        error: { code: "claude_failed", message: "boom" },
      },
      pull,
    );
    expect(payload.body).toContain("claude_failed");
    expect(payload.body).toContain("boom");
    expect(payload.body).toContain(reviewIdMarker("rev2"));
    expect(payload.body).not.toContain(NO_FINDINGS_SUMMARY);
    expect(payload.comments).toEqual([]);
  });

  it("inline only for matching repo + path in files + lineStart", () => {
    const payload = buildGithubReviewPayload(
      {
        reviewId: "rev3",
        status: "completed",
        report: {
          summary: "issues found",
          findings: [
            finding({
              title: "inline me",
              repo: "acme/be",
              filePath: "./src/A.cs",
              lineStart: 10,
              lineEnd: 12,
              suggestedAction: "fix it",
            }),
            finding({
              title: "bare repo",
              repo: "be",
              filePath: "src/B.cs",
              lineStart: 5,
            }),
          ],
        },
      },
      pull,
    );
    expect(payload.comments).toHaveLength(2);
    expect(payload.comments[0]).toMatchObject({
      path: "src/A.cs",
      start_line: 10,
      line: 12,
      side: "RIGHT",
      start_side: "RIGHT",
    });
    expect(payload.comments[0]!.body).toContain("inline me");
    expect(payload.comments[0]!.body).toContain("fix it");
    expect(payload.comments[1]).toMatchObject({
      path: "src/B.cs",
      line: 5,
    });
    expect(payload.comments[1]).not.toHaveProperty("start_line");
  });

  it("path not in PR files stays body-only", () => {
    const payload = buildGithubReviewPayload(
      {
        reviewId: "rev4b",
        status: "completed",
        report: {
          summary: "missing path",
          findings: [
            finding({
              title: "unknown file",
              repo: "acme/be",
              filePath: "src/NotInPr.cs",
              lineStart: 3,
            }),
          ],
        },
      },
      pull,
    );
    expect(payload.comments).toEqual([]);
    expect(payload.body).toContain("unknown file");
  });

  it("cross-repo finding stays body-only", () => {
    const payload = buildGithubReviewPayload(
      {
        reviewId: "rev4",
        status: "completed",
        report: {
          summary: "cross",
          findings: [
            finding({
              title: "fe issue",
              repo: "acme/fe",
              filePath: "src/A.cs",
              lineStart: 1,
            }),
          ],
        },
      },
      pull,
    );
    expect(payload.comments).toEqual([]);
    expect(payload.body).toContain("fe issue");
  });

  it("caps inline comments at 20", () => {
    const findings = Array.from({ length: 25 }, (_, i) =>
      finding({
        title: `f${i}`,
        repo: "acme/be",
        filePath: "src/A.cs",
        lineStart: i + 1,
      }),
    );
    const payload = buildGithubReviewPayload(
      {
        reviewId: "rev5",
        status: "completed",
        report: { summary: "many", findings },
      },
      pull,
    );
    expect(payload.comments).toHaveLength(20);
    expect(payload.body).toMatch(/5 more findings omitted/i);
  });
});
