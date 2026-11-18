import { describe, expect, it } from "vitest";
import { handleTeamsHttpRequest } from "../src/handle-request.js";

describe("handleTeamsHttpRequest", () => {
  it("GET /healthz returns 200 { ok: true }", async () => {
    const result = await handleTeamsHttpRequest(
      {
        method: "GET",
        path: "/healthz",
        headers: {},
        rawBody: Buffer.alloc(0),
      },
      {
        secret: "sec",
        worker: {
          enqueue: async () => ({ reviewId: "x", duplicated: false }),
        },
      },
    );
    expect(result).toEqual({ status: 200, body: { ok: true } });
  });
});
