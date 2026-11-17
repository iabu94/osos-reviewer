import { describe, expect, it } from "vitest";
import { resolvePrBranchesViaGithub } from "../src/github-pr.js";

describe("resolvePrBranchesViaGithub", () => {
  it("resolvePrBranchesViaGithub maps head and base refs", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          head: { ref: "feature/ABC-1" },
          base: { ref: "develop" },
        }),
        { status: 200 },
      );
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