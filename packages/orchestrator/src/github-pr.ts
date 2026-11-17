import type { PrBranches } from "./review.js";
import { parsePrUrl } from "./review.js";

export async function resolvePrBranchesViaGithub(
  prUrl: string,
  opts: { token: string; fetchImpl?: typeof fetch },
): Promise<PrBranches> {
  const { owner, repo, number } = parsePrUrl(prUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub pull request lookup failed with status ${res.status}`,
    );
  }
  const json = (await res.json()) as {
    head: { ref: string };
    base: { ref: string };
  };
  const headRef = json.head.ref;
  return {
    primaryBranch: headRef,
    targetBranch: json.base.ref,
    headRef,
  };
}