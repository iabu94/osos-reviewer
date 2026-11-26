import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { NO_FINDINGS_SUMMARY } from "@osos-reviewer/shared";
import { parseClaudeReviewOutput } from "../src/parse-claude.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return join(__dirname, "..", "fixtures", "claude", name);
}

describe("parseClaudeReviewOutput", () => {
  it("parses success-finding into report and diagnostics", () => {
    const raw = readFileSync(fixture("success-finding.json"), "utf8");
    const parsed = parseClaudeReviewOutput(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.findings[0]!.category).toBe("integration");
    expect(parsed.diagnostics.inputTokens).toBe(100);
    expect(parsed.diagnostics.durationMs).toBe(1500);
  });

  it("forces NO_FINDINGS_SUMMARY when findings empty", () => {
    const parsed = parseClaudeReviewOutput(
      readFileSync(fixture("success-no-findings.json"), "utf8"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.summary).toBe(NO_FINDINGS_SUMMARY);
    expect(parsed.report.findings).toEqual([]);
  });

  it("fails when structured_output missing", () => {
    const parsed = parseClaudeReviewOutput(
      readFileSync(fixture("missing-structured-output.json"), "utf8"),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("invalid_review_output");
  });

  it("fails invalid finding evidence", () => {
    const parsed = parseClaudeReviewOutput(
      readFileSync(fixture("invalid-finding.json"), "utf8"),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("invalid_review_output");
  });
});