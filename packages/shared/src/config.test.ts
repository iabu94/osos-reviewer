import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const baseEnv = {
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
} as const;

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

  it("loads Teams and concurrency settings when REQUIRE_TEAMS=true", () => {
    const cfg = loadConfig({
      ...baseEnv,
      REQUIRE_TEAMS: "true",
      TEAMS_WEBHOOK_SECRET: "sec",
      TEAMS_BOT_APP_ID: "app",
      TEAMS_BOT_PASSWORD: "pwd",
      TEAMS_WEBHOOK_PORT: "3099",
      MAX_CONCURRENT_REVIEWS: "1",
      REVIEW_RETRY_MAX: "3",
      GITHUB_TOKEN: "gh",
    });
    expect(cfg.teams.port).toBe(3099);
    expect(cfg.teams.webhookSecret).toBe("sec");
    expect(cfg.teams.replyFlowUrl).toBe("");
    expect(cfg.maxConcurrentReviews).toBe(1);
    expect(cfg.reviewRetryMax).toBe(3);
    expect(cfg.githubToken).toBe("gh");
  });

  it("loads Power Automate reply flow when REQUIRE_TEAMS=true", () => {
    const cfg = loadConfig({
      ...baseEnv,
      REQUIRE_TEAMS: "true",
      TEAMS_WEBHOOK_SECRET: "sec",
      TEAMS_REPLY_FLOW_URL: "https://prod-00.logic.azure.com/workflows/abc",
    });
    expect(cfg.teams.replyFlowUrl).toContain("logic.azure.com");
    expect(cfg.teams.botAppId).toBe("");
    expect(cfg.teams.botPassword).toBe("");
  });

  it("throws ConfigError when REQUIRE_TEAMS=true and secret missing", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        REQUIRE_TEAMS: "true",
        TEAMS_BOT_APP_ID: "a",
        TEAMS_BOT_PASSWORD: "b",
      }),
    ).toThrow(/TEAMS_WEBHOOK_SECRET/);
  });

  it("throws ConfigError when REQUIRE_TEAMS=true and neither flow nor bot set", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        REQUIRE_TEAMS: "true",
        TEAMS_WEBHOOK_SECRET: "sec",
      }),
    ).toThrow(/TEAMS_REPLY_FLOW_URL|TEAMS_BOT_APP_ID/);
  });

  it("allows empty Teams settings when REQUIRE_TEAMS is unset", () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.teams.port).toBe(3080);
    expect(cfg.teams.webhookSecret).toBe("");
    expect(cfg.teams.replyFlowUrl).toBe("");
    expect(cfg.maxConcurrentReviews).toBe(2);
    expect(cfg.reviewRetryMax).toBe(2);
    expect(cfg.githubToken).toBeUndefined();
  });

  it("githubReviewDelivery defaults from GITHUB_TOKEN and GITHUB_REVIEW_DELIVERY", () => {
    expect(loadConfig({ ...baseEnv, GITHUB_TOKEN: "gh" }).githubReviewDelivery).toBe(
      true,
    );
    expect(
      loadConfig({
        ...baseEnv,
        GITHUB_TOKEN: "gh",
        GITHUB_REVIEW_DELIVERY: "false",
      }).githubReviewDelivery,
    ).toBe(false);
    expect(
      loadConfig({
        ...baseEnv,
        GITHUB_REVIEW_DELIVERY: "true",
      }).githubReviewDelivery,
    ).toBe(false);
  });
});
