import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("parses REPOS_JSON and default ticket pattern", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://review:review@localhost:5432/review",
      WORKTREE_ROOT: "/tmp/review-worktrees",
      CLAUDE_CLI_PATH: "claude",
      EMBEDDING_PROVIDER: "fake",
      REPOS_JSON: JSON.stringify([
        {
          id: "be",
          role: "backend",
          localPath: "/repos/be",
          defaultBaseBranch: "develop",
        },
        {
          id: "fe",
          role: "frontend",
          localPath: "/repos/fe",
          defaultBaseBranch: "develop",
        },
      ]),
    });
    expect(cfg.ticketPattern.source).toBe("[A-Z]+-\\d+");
    expect(cfg.repos).toHaveLength(2);
    expect(cfg.companionFallbackBranch).toBe("origin/develop");
    expect(cfg.knowledgeBasePath).toBe("knowledge-base");
    expect(cfg.embedding.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.embedding.model).toBe("text-embedding-3-small");
  });

  it("throws ConfigError when REPOS_JSON is missing", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://x", WORKTREE_ROOT: "/tmp" }),
    ).toThrow(/REPOS_JSON/);
  });

  it("loads knowledge base and embedding config", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://review:review@localhost:5433/review",
      WORKTREE_ROOT: "/tmp/review-worktrees",
      CLAUDE_CLI_PATH: "claude",
      REPOS_JSON: JSON.stringify([
        {
          id: "be",
          role: "backend",
          localPath: "/repos/be",
          defaultBaseBranch: "develop",
        },
        {
          id: "fe",
          role: "frontend",
          localPath: "/repos/fe",
          defaultBaseBranch: "develop",
        },
      ]),
      KNOWLEDGE_BASE_PATH: "/kb",
      EMBEDDING_PROVIDER: "fake",
      EMBEDDING_MODEL: "text-embedding-3-small",
    });

    expect(cfg.knowledgeBasePath).toBe("/kb");
    expect(cfg.embedding.provider).toBe("fake");
    expect(cfg.embedding.dimensions).toBe(768);
  });

  it("requires EMBEDDING_API_KEY when provider is openai_compatible", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://review:review@localhost:5433/review",
        WORKTREE_ROOT: "/tmp/review-worktrees",
        CLAUDE_CLI_PATH: "claude",
        REPOS_JSON: JSON.stringify([
          {
            id: "be",
            role: "backend",
            localPath: "/repos/be",
            defaultBaseBranch: "develop",
          },
          {
            id: "fe",
            role: "frontend",
            localPath: "/repos/fe",
            defaultBaseBranch: "develop",
          },
        ]),
        EMBEDDING_PROVIDER: "openai_compatible",
      }),
    ).toThrow(/EMBEDDING_API_KEY/);
  });
});
