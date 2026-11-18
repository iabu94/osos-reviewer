import type { ReviewResult } from "@review/shared";
import { fetchGithubPullDetails } from "./github-pr.js";
import {
  buildGithubReviewPayload,
  reviewIdMarker,
} from "./github-review-markdown.js";

export class GithubDeliveryError extends Error {
  readonly code = "github_delivery_failed" as const;

  constructor(message: string) {
    super(`github_delivery_failed: ${message}`);
    this.name = "GithubDeliveryError";
  }
}

export type GithubReviewPostResult = {
  status: "created" | "skipped";
  title: string;
  headSha: string;
  htmlUrl?: string;
};

export type GithubReviewPoster = {
  postReview(input: {
    prUrl: string;
    result: ReviewResult;
  }): Promise<GithubReviewPostResult>;
};

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };
}

export function createGithubReviewPoster(opts: {
  token: string;
  fetchImpl?: typeof fetch;
}): GithubReviewPoster {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async postReview({ prUrl, result }) {
      const details = await fetchGithubPullDetails(prUrl, {
        token: opts.token,
        fetchImpl,
      });

      const listUrl = `https://api.github.com/repos/${details.owner}/${details.repo}/pulls/${details.number}/reviews`;
      const listRes = await fetchImpl(listUrl, {
        headers: githubHeaders(opts.token),
      });
      if (!listRes.ok) {
        throw new GithubDeliveryError(
          `list reviews failed with status ${listRes.status}`,
        );
      }
      const existing = (await listRes.json()) as Array<{ body?: string | null }>;
      const marker = reviewIdMarker(result.reviewId);
      if (existing.some((r) => (r.body ?? "").includes(marker))) {
        return {
          status: "skipped",
          title: details.title,
          headSha: details.headSha,
        };
      }

      const payload = buildGithubReviewPayload(result, details);
      const postRes = await fetchImpl(listUrl, {
        method: "POST",
        headers: {
          ...githubHeaders(opts.token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!postRes.ok) {
        throw new GithubDeliveryError(
          `create review failed with status ${postRes.status}`,
        );
      }
      const created = (await postRes.json()) as { html_url?: string };
      return {
        status: "created",
        title: details.title,
        headSha: details.headSha,
        ...(typeof created.html_url === "string"
          ? { htmlUrl: created.html_url }
          : {}),
      };
    },
  };
}
