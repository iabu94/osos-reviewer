import type { ReviewResult } from "@osos-reviewer/shared";
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

/** Applied to the trigger PR after a completed review is delivered to GitHub. */
export const AI_REVIEW_COMPLETED_LABEL = "ai-review:completed";

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };
}

async function addCompletedLabel(opts: {
  owner: string;
  repo: string;
  number: number;
  token: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const labelsUrl = `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues/${opts.number}/labels`;
  const res = await opts.fetchImpl(labelsUrl, {
    method: "POST",
    headers: {
      ...githubHeaders(opts.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ labels: [AI_REVIEW_COMPLETED_LABEL] }),
  });
  if (!res.ok) {
    throw new GithubDeliveryError(
      `add label failed with status ${res.status}`,
    );
  }
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
      const alreadyPosted = existing.some((r) =>
        (r.body ?? "").includes(marker),
      );

      let out: GithubReviewPostResult;
      if (alreadyPosted) {
        out = {
          status: "skipped",
          title: details.title,
          headSha: details.headSha,
        };
      } else {
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
        out = {
          status: "created",
          title: details.title,
          headSha: details.headSha,
          ...(typeof created.html_url === "string"
            ? { htmlUrl: created.html_url }
            : {}),
        };
      }

      if (result.status === "completed") {
        await addCompletedLabel({
          owner: details.owner,
          repo: details.repo,
          number: details.number,
          token: opts.token,
          fetchImpl,
        });
      }

      return out;
    },
  };
}
