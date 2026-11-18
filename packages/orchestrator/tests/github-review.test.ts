import { describe, expect, it } from "vitest";
import {
  AI_REVIEW_COMPLETED_LABEL,
  createGithubReviewPoster,
  GithubDeliveryError,
} from "../src/github-review.js";
import { reviewIdMarker } from "../src/github-review-markdown.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("createGithubReviewPoster", () => {
  it("creates COMMENT review with commit_id and marker", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const labelPosts: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pulls/1") && !url.includes("/reviews") && !url.includes("/files")) {
        return jsonResponse({
          title: "feat: demo",
          head: { ref: "feat", sha: "abc123" },
          base: { ref: "main" },
        });
      }
      if (url.includes("/pulls/1/files")) {
        return jsonResponse([{ filename: "src/A.cs" }]);
      }
      if (url.includes("/pulls/1/reviews") && (!init?.method || init.method === "GET")) {
        return jsonResponse([]);
      }
      if (url.includes("/pulls/1/reviews") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push({ url, body });
        return jsonResponse(
          {
            id: 99,
            html_url:
              "https://github.com/acme/be/pull/1#pullrequestreview-99",
          },
          201,
        );
      }
      if (url.includes("/issues/1/labels") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        labelPosts.push({ url, body });
        return jsonResponse([{ name: AI_REVIEW_COMPLETED_LABEL }], 200);
      }
      throw new Error(`unexpected ${url} ${init?.method}`);
    };

    const poster = createGithubReviewPoster({ token: "t", fetchImpl });
    const out = await poster.postReview({
      prUrl: "https://github.com/acme/be/pull/1",
      result: {
        reviewId: "rev1",
        status: "completed",
        report: { summary: "ok", findings: [] },
      },
    });

    expect(out).toEqual({
      status: "created",
      title: "feat: demo",
      headSha: "abc123",
      htmlUrl: "https://github.com/acme/be/pull/1#pullrequestreview-99",
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      event: "COMMENT",
      commit_id: "abc123",
    });
    expect((posts[0]!.body as { body: string }).body).toContain(
      reviewIdMarker("rev1"),
    );
    expect(labelPosts).toEqual([
      {
        url: "https://api.github.com/repos/acme/be/issues/1/labels",
        body: { labels: [AI_REVIEW_COMPLETED_LABEL] },
      },
    ]);
  });

  it("skips review post but still labels completed reviews", async () => {
    let reviewPostCount = 0;
    const labelPosts: unknown[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pulls/1") && !url.includes("/reviews") && !url.includes("/files")) {
        return jsonResponse({
          title: "feat: demo",
          head: { ref: "feat", sha: "abc123" },
          base: { ref: "main" },
        });
      }
      if (url.includes("/pulls/1/files")) {
        return jsonResponse([]);
      }
      if (url.includes("/pulls/1/reviews") && (!init?.method || init.method === "GET")) {
        return jsonResponse([
          { id: 1, body: `prior\n${reviewIdMarker("rev1")}\n` },
        ]);
      }
      if (url.includes("/pulls/1/reviews") && init?.method === "POST") {
        reviewPostCount++;
        return jsonResponse({}, 201);
      }
      if (url.includes("/issues/1/labels") && init?.method === "POST") {
        labelPosts.push(JSON.parse(String(init.body)));
        return jsonResponse([{ name: AI_REVIEW_COMPLETED_LABEL }], 200);
      }
      throw new Error(`unexpected ${url}`);
    };

    const poster = createGithubReviewPoster({ token: "t", fetchImpl });
    const out = await poster.postReview({
      prUrl: "https://github.com/acme/be/pull/1",
      result: {
        reviewId: "rev1",
        status: "completed",
        report: { summary: "ok", findings: [] },
      },
    });

    expect(out).toEqual({
      status: "skipped",
      title: "feat: demo",
      headSha: "abc123",
    });
    expect(reviewPostCount).toBe(0);
    expect(labelPosts).toEqual([{ labels: [AI_REVIEW_COMPLETED_LABEL] }]);
  });

  it("does not label failed reviews", async () => {
    const labelPosts: unknown[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pulls/1") && !url.includes("/reviews") && !url.includes("/files")) {
        return jsonResponse({
          title: "feat: demo",
          head: { ref: "feat", sha: "abc123" },
          base: { ref: "main" },
        });
      }
      if (url.includes("/pulls/1/files")) {
        return jsonResponse([]);
      }
      if (url.includes("/pulls/1/reviews") && (!init?.method || init.method === "GET")) {
        return jsonResponse([]);
      }
      if (url.includes("/pulls/1/reviews") && init?.method === "POST") {
        return jsonResponse({ id: 99 }, 201);
      }
      if (url.includes("/issues/1/labels") && init?.method === "POST") {
        labelPosts.push(JSON.parse(String(init.body)));
        return jsonResponse([], 200);
      }
      throw new Error(`unexpected ${url}`);
    };

    const poster = createGithubReviewPoster({ token: "t", fetchImpl });
    await poster.postReview({
      prUrl: "https://github.com/acme/be/pull/1",
      result: {
        reviewId: "rev1",
        status: "failed",
        error: { code: "claude_timeout", message: "timed out" },
      },
    });

    expect(labelPosts).toEqual([]);
  });

  it("throws GithubDeliveryError on 500", async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pulls/1") && !url.includes("/reviews") && !url.includes("/files")) {
        return jsonResponse({
          head: { ref: "feat", sha: "abc123" },
          base: { ref: "main" },
        });
      }
      if (url.includes("/pulls/1/files")) {
        return jsonResponse([]);
      }
      if (url.includes("/pulls/1/reviews") && (!init?.method || init.method === "GET")) {
        return jsonResponse([]);
      }
      if (url.includes("/pulls/1/reviews") && init?.method === "POST") {
        return new Response("fail", { status: 500 });
      }
      throw new Error(`unexpected ${url}`);
    };

    const poster = createGithubReviewPoster({ token: "t", fetchImpl });
    await expect(
      poster.postReview({
        prUrl: "https://github.com/acme/be/pull/1",
        result: {
          reviewId: "rev1",
          status: "completed",
          report: { summary: "ok", findings: [] },
        },
      }),
    ).rejects.toMatchObject({
      name: "GithubDeliveryError",
      code: "github_delivery_failed",
    });
    await expect(
      poster.postReview({
        prUrl: "https://github.com/acme/be/pull/1",
        result: {
          reviewId: "rev1",
          status: "completed",
          report: { summary: "ok", findings: [] },
        },
      }),
    ).rejects.toBeInstanceOf(GithubDeliveryError);
  });

  it("throws GithubDeliveryError when labeling fails", async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/pulls/1") && !url.includes("/reviews") && !url.includes("/files")) {
        return jsonResponse({
          title: "feat: demo",
          head: { ref: "feat", sha: "abc123" },
          base: { ref: "main" },
        });
      }
      if (url.includes("/pulls/1/files")) {
        return jsonResponse([]);
      }
      if (url.includes("/pulls/1/reviews") && (!init?.method || init.method === "GET")) {
        return jsonResponse([]);
      }
      if (url.includes("/pulls/1/reviews") && init?.method === "POST") {
        return jsonResponse({ id: 99 }, 201);
      }
      if (url.includes("/issues/1/labels") && init?.method === "POST") {
        return new Response("fail", { status: 500 });
      }
      throw new Error(`unexpected ${url}`);
    };

    const poster = createGithubReviewPoster({ token: "t", fetchImpl });
    await expect(
      poster.postReview({
        prUrl: "https://github.com/acme/be/pull/1",
        result: {
          reviewId: "rev1",
          status: "completed",
          report: { summary: "ok", findings: [] },
        },
      }),
    ).rejects.toMatchObject({
      name: "GithubDeliveryError",
      code: "github_delivery_failed",
      message: expect.stringContaining("add label failed"),
    });
  });
});
