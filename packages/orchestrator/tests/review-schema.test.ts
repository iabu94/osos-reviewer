import { describe, it, expect } from "vitest";
import { NO_FINDINGS_SUMMARY } from "@review/shared";
import { parseReviewReport, REVIEW_OUTPUT_JSON_SCHEMA } from "../src/review-schema.js";

describe("review-schema", () => {
  it("accepts a confirmed integration finding with evidence", () => {
    const report = parseReviewReport({
      summary: "One integration mismatch",
      findings: [
        {
          category: "integration",
          severity: "high",
          confidence: "confirmed",
          title: "FE calls missing BE route",
          description:
            "Angular service posts to /api/order but no matching controller action.",
          evidence:
            "HTTP POST /api/order in OrderService; no backend endpoint for that path.",
          repo: "fe",
          filePath: "broken-order.service.ts",
          lineStart: 10,
          lineEnd: 20,
          suggestedAction: "Align FE path with BE or add the endpoint.",
        },
      ],
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.category).toBe("integration");
  });

  it("rejects confirmed finding with empty evidence", () => {
    expect(() =>
      parseReviewReport({
        summary: "x",
        findings: [
          {
            category: "other",
            severity: "low",
            confidence: "confirmed",
            title: "t",
            description: "d",
            evidence: "",
          },
        ],
      }),
    ).toThrow();
  });

  it("REVIEW_OUTPUT_JSON_SCHEMA requires summary and findings", () => {
    expect(REVIEW_OUTPUT_JSON_SCHEMA).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["summary", "findings"]),
    });
  });
});