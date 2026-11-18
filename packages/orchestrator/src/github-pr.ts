import type { PrBranches } from "./review.js";
import { parsePrUrl } from "./review.js";

export type GithubPullDetails = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  filePaths: string[];
};

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };
}

export async function fetchGithubPullDetails(
  prUrl: string,
  opts: { token: string; fetchImpl?: typeof fetch },
): Promise<GithubPullDetails> {
  const { owner, repo, number } = parsePrUrl(prUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pullRes = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    { headers: githubHeaders(opts.token) },
  );
  if (!pullRes.ok) {
    throw new Error(
      `GitHub pull request lookup failed with status ${pullRes.status}`,
    );
  }
  const pullJson = (await pullRes.json()) as {
    title?: string;
    head: { ref: string; sha: string };
    base: { ref: string };
  };

  const filePaths: string[] = [];
  let filesUrl: string | null =
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`;
  while (filesUrl) {
    const filesRes = await fetchImpl(filesUrl, {
      headers: githubHeaders(opts.token),
    });
    if (!filesRes.ok) {
      throw new Error(
        `GitHub pull request files lookup failed with status ${filesRes.status}`,
      );
    }
    const filesJson = (await filesRes.json()) as Array<{ filename: string }>;
    for (const f of filesJson) {
      filePaths.push(f.filename);
    }
    const link = filesRes.headers.get("link") ?? filesRes.headers.get("Link");
    filesUrl = null;
    if (link) {
      const next = link
        .split(",")
        .map((part) => part.trim())
        .find((part) => part.includes('rel="next"'));
      if (next) {
        const match = next.match(/<([^>]+)>/);
        filesUrl = match?.[1] ?? null;
      }
    }
  }

  return {
    owner,
    repo,
    number,
    title: typeof pullJson.title === "string" ? pullJson.title : "",
    headSha: pullJson.head.sha,
    headRef: pullJson.head.ref,
    baseRef: pullJson.base.ref,
    filePaths,
  };
}

export async function resolvePrBranchesViaGithub(
  prUrl: string,
  opts: { token: string; fetchImpl?: typeof fetch },
): Promise<PrBranches> {
  const details = await fetchGithubPullDetails(prUrl, opts);
  return {
    primaryBranch: details.headRef,
    targetBranch: details.baseRef,
    headRef: details.headRef,
  };
}
