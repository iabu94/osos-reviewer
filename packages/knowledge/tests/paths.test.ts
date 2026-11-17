import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveKnowledgeBasePath } from "../src/index.js";

describe("resolveKnowledgeBasePath", () => {
  it("resolves relative paths from the repo root, not the cwd", () => {
    expect(resolveKnowledgeBasePath("knowledge-base", "/repo")).toBe(
      resolve("/repo", "knowledge-base"),
    );
    const fromDefaultRoot = resolveKnowledgeBasePath("knowledge-base");
    expect(fromDefaultRoot.endsWith("/knowledge-base")).toBe(true);
    expect(fromDefaultRoot).not.toBe(resolve(process.cwd(), "knowledge-base"));
  });

  it("keeps absolute paths as-is", () => {
    expect(resolveKnowledgeBasePath("/data/kb", "/repo")).toBe("/data/kb");
  });
});
