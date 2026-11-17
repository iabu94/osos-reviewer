import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { createTeamsWebhookServer } from "../src/server.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function hmacSha256Hex(body: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function listen(server: Server): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("unexpected server address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

describe("createTeamsWebhookServer", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          }),
      ),
    );
    servers.length = 0;
  });

  it("POST /hooks/teams returns 202 and enqueues", async () => {
    const enqueues: unknown[] = [];
    const server = createTeamsWebhookServer({
      secret: "sec",
      worker: {
        enqueue: async (input) => {
          enqueues.push(input);
          return { reviewId: "rid", duplicated: false };
        },
      },
    });
    servers.push(server);
    const { url, close } = await listen(server);
    const body = await readFile(join(fixturesDir, "activity-valid.json"));
    const res = await fetch(`${url}/hooks/teams`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-review-signature": `sha256=${hmacSha256Hex(body, "sec")}`,
      },
      body,
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as {
      reviewId: string;
      duplicated: boolean;
      status: string;
    };
    expect(json).toEqual({
      reviewId: "rid",
      duplicated: false,
      status: "accepted",
    });
    expect(enqueues).toHaveLength(1);
    await close();
  });

  it("rejects bad signature with 401", async () => {
    const server = createTeamsWebhookServer({
      secret: "sec",
      worker: {
        enqueue: async () => ({ reviewId: "rid", duplicated: false }),
      },
    });
    servers.push(server);
    const { url, close } = await listen(server);
    const body = await readFile(join(fixturesDir, "activity-valid.json"));
    const res = await fetch(`${url}/hooks/teams`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-review-signature": "sha256=deadbeef",
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    await close();
  });

  it("rejects activity without PR with 400 missing_pr_url", async () => {
    const server = createTeamsWebhookServer({
      secret: "sec",
      worker: {
        enqueue: async () => ({ reviewId: "rid", duplicated: false }),
      },
    });
    servers.push(server);
    const { url, close } = await listen(server);
    const body = await readFile(join(fixturesDir, "activity-no-pr.json"));
    const res = await fetch(`${url}/hooks/teams`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-review-signature": `sha256=${hmacSha256Hex(body, "sec")}`,
      },
      body,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "missing_pr_url",
      message: "GitHub pull request URL is required",
    });
    await close();
  });

  it("GET /healthz returns 200 ok", async () => {
    const server = createTeamsWebhookServer({
      secret: "sec",
      worker: {
        enqueue: async () => ({ reviewId: "rid", duplicated: false }),
      },
    });
    servers.push(server);
    const { url, close } = await listen(server);
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await close();
  });
});