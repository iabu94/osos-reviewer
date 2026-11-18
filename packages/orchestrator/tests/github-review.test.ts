import { describe, expect, it } from "vitest";
import {
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
  });

  it("skips when marker already present", async () => {
    let postCount = 0;
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
      if (init?.method === "POST") {
        postCount++;
        return jsonResponse({}, 201);
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
    expect(postCount).toBe(0);
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
      if (init?.method === "POST") {
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
});
