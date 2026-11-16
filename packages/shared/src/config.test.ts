import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("parses REPOS_JSON and default ticket pattern", () => {
    const cfg = loadConfig({
      DATABASE_URL: "postgres://review:review@localhost:5432/review",
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
    });
    expect(cfg.ticketPattern.source).toBe("[A-Z]+-\\d+");
    expect(cfg.repos).toHaveLength(2);
    expect(cfg.companionFallbackBranch).toBe("origin/develop");
  });

  it("throws ConfigError when REPOS_JSON is missing", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://x", WORKTREE_ROOT: "/tmp" }),
    ).toThrow(/REPOS_JSON/);
  });
});
