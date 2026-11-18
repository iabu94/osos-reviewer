import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { TeamsWebhookWorker } from "@review/teams";
import { TeamsController } from "../src/teams.controller.js";
import {
  TEAMS_WEBHOOK_LOGGER,
  TEAMS_WEBHOOK_SECRET,
  TEAMS_WEBHOOK_WORKER,
} from "../src/review-tokens.js";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
};

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/teams/fixtures",
);

function hmacSha256Hex(body: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("Teams webhook Nest e2e", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("POST /teams-hook returns 202 and enqueues with review signature", async () => {
    const enqueues: unknown[] = [];
    const worker: TeamsWebhookWorker = {
      enqueue: async (input) => {
        enqueues.push(input);
        return { reviewId: "rid", duplicated: false };
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [TeamsController],
      providers: [
        { provide: TEAMS_WEBHOOK_SECRET, useValue: "sec" },
        { provide: TEAMS_WEBHOOK_WORKER, useValue: worker },
        { provide: TEAMS_WEBHOOK_LOGGER, useValue: noopLogger },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.listen(0, "127.0.0.1");
    const url = await app.getUrl();

    const body = await readFile(join(fixturesDir, "activity-valid.json"));
    const res = await fetch(`${url}/teams-hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-review-signature": `sha256=${hmacSha256Hex(body, "sec")}`,
      },
      body,
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      reviewId: "rid",
      duplicated: false,
      status: "accepted",
    });
    expect(enqueues).toHaveLength(1);
  });

  it("POST /teams-hook accepts Teams Authorization HMAC and returns message", async () => {
    const TEAMS_TOKEN = "vqF0En+Z0ucuRTM/01o2GuhMH3hKKk/N2bOmlM31zaA=";
    const worker: TeamsWebhookWorker = {
      enqueue: async () => ({ reviewId: "rid-teams", duplicated: false }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [TeamsController],
      providers: [
        { provide: TEAMS_WEBHOOK_SECRET, useValue: TEAMS_TOKEN },
        { provide: TEAMS_WEBHOOK_WORKER, useValue: worker },
        { provide: TEAMS_WEBHOOK_LOGGER, useValue: noopLogger },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.listen(0, "127.0.0.1");
    const url = await app.getUrl();

    const body = await readFile(join(fixturesDir, "activity-valid.json"));
    const key = Buffer.from(TEAMS_TOKEN, "base64");
    const digest = createHmac("sha256", key).update(body).digest("base64");
    const res = await fetch(`${url}/teams-hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `HMAC ${digest}`,
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      type: "message",
      text: "Review accepted (rid-teams). I'll post findings in this thread.",
    });
  });
});
