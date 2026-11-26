import type { CodeSymbolRecord } from "@osos-reviewer/shared";
import { describe, expect, it } from "vitest";
import { mergePreferPr } from "../src/merge-scope.js";

function stub(partial: Partial<CodeSymbolRecord> & Pick<CodeSymbolRecord, "repo" | "filePath" | "symbolName" | "indexScope">): CodeSymbolRecord {
  return {
    id: 1,
    revision: "rev",
    branchTag: null,
    reviewId: partial.indexScope === "pr" ? "r1" : null,
    symbolType: "dto",
    lineStart: null,
    lineEnd: null,
    signature: "",
    summary: null,
    metadata: {},
    commitSha: "sha",
    contentHash: "hash",
    ...partial,
  };
}

describe("mergePreferPr", () => {
  it("prefers PR row over baseline for the same key", () => {
    const merged = mergePreferPr([
      stub({ repo: "be", filePath: "a.cs", symbolName: "X", indexScope: "baseline" }),
      stub({ repo: "be", filePath: "a.cs", symbolName: "X", indexScope: "pr", reviewId: "r1" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].indexScope).toBe("pr");
  });
});