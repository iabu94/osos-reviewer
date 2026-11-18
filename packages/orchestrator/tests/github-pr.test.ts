import { describe, expect, it } from "vitest";
import {
  fetchGithubPullDetails,
  resolvePrBranchesViaGithub,
} from "../src/github-pr.js";

describe("fetchGithubPullDetails", () => {
  it("fetchGithubPullDetails returns headSha and file paths", async () => {
    const fetchImpl = async (url: string) => {
      if (String(url).endsWith("/pulls/1")) {
        return new Response(
          JSON.stringify({
            head: { ref: "feat", sha: "abc123" },
            base: { ref: "main" },
          }),
          { status: 200 },
        );
      }
      if (String(url).includes("/pulls/1/files")) {
        return new Response(
          JSON.stringify([
            { filename: "src/A.cs" },
            { filename: "src/B.cs" },
          ]),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${url}`);
    };
    const d = await fetchGithubPullDetails(
      "https://github.com/acme/be/pull/1",
      { token: "t", fetchImpl },
    );
    expect(d.headSha).toBe("abc123");
    expect(d.filePaths).toEqual(["src/A.cs", "src/B.cs"]);
  });
});

describe("resolvePrBranchesViaGithub", () => {
  it("resolvePrBranchesViaGithub maps head and base refs", async () => {
    const fetchImpl = async (url: string) => {
      if (String(url).includes("/files")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          head: { ref: "feature/ABC-1", sha: "deadbeef" },
          base: { ref: "develop" },
        }),
        { status: 200 },
      );
    };
    const b = await resolvePrBranchesViaGithub(
      "https://github.com/acme/be/pull/9",
      { token: "t", fetchImpl },
    );
    expect(b).toEqual({
      primaryBranch: "feature/ABC-1",
      targetBranch: "develop",
      headRef: "feature/ABC-1",
    });
  });

  it("throws with status on API failure", async () => {
    const fetchImpl = async () => new Response("nope", { status: 404 });
    await expect(
      resolvePrBranchesViaGithub("https://github.com/acme/be/pull/9", {
        token: "t",
        fetchImpl,
      }),
    ).rejects.toThrow(/404/);
  });
});