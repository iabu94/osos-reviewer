import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { TeamsWebhookLogger, TeamsWebhookWorker } from "@osos-reviewer/teams";
import { TeamsController } from "../src/teams.controller.js";
import {
  TEAMS_WEBHOOK_LOGGER,
  TEAMS_WEBHOOK_SECRET,
  TEAMS_WEBHOOK_WORKER,
} from "../src/review-tokens.js";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/teams/fixtures",
);

describe("TeamsController logger wiring", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("passes logger so accepted webhooks emit teams webhook accepted", async () => {
    const infoCalls: Array<{ msg: string; fields?: Record<string, unknown> }> =
      [];
    const logger: TeamsWebhookLogger = {
      info(msg, fields) {
        infoCalls.push({ msg, fields });
      },
      warn() {},
      error() {},
    };
    const worker: TeamsWebhookWorker = {
      enqueue: async () => ({ reviewId: "rid", duplicated: false }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [TeamsController],
      providers: [
        { provide: TEAMS_WEBHOOK_SECRET, useValue: "sec" },
        { provide: TEAMS_WEBHOOK_WORKER, useValue: worker },
        { provide: TEAMS_WEBHOOK_LOGGER, useValue: logger },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.listen(0, "127.0.0.1");
    const url = await app.getUrl();
    const body = await readFile(join(fixturesDir, "activity-valid.json"));
    const sig = createHmac("sha256", "sec").update(body).digest("hex");
    const res = await fetch(`${url}/teams-hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-review-signature": `sha256=${sig}`,
      },
      body,
    });
    expect(res.status).toBe(202);
    expect(infoCalls.some((c) => c.msg === "teams webhook accepted")).toBe(
      true,
    );
  });
});
