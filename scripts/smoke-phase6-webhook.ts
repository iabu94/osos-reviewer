import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { createTeamsWebhookServer } from "../packages/teams/src/server.js";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/teams/fixtures/activity-valid.json",
);

function sign(body: Buffer, secret: string): string {
  const hex = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}

async function main(): Promise<void> {
  const secret = "smoke-phase6-secret";
  const enqueues: unknown[] = [];
  const server: Server = createTeamsWebhookServer({
    secret,
    worker: {
      enqueue: async (input) => {
        enqueues.push(input);
        return { reviewId: "smoke-review", duplicated: false };
      },
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("unexpected listen address");
  }
  const url = `http://127.0.0.1:${addr.port}`;
  const body = await readFile(fixture);

  const res = await fetch(`${url}/hooks/teams`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-review-signature": sign(body, secret),
    },
    body,
  });

  if (res.status !== 202) {
    throw new Error(`expected 202, got ${res.status}: ${await res.text()}`);
  }
  if (enqueues.length !== 1) {
    throw new Error(`expected one enqueue, got ${enqueues.length}`);
  }

  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});