import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTeamsTrigger } from "../src/parse-trigger.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

describe("parseTeamsTrigger", () => {
  it("parses valid activity fixture", async () => {
    const activity = JSON.parse(
      await readFile(join(fixturesDir, "activity-valid.json"), "utf8"),
    );
    const parsed = parseTeamsTrigger(activity);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.prUrl).toMatch(/\/pull\/1$/);
      expect(parsed.idempotencyKey).toBe(activity.id);
      expect(parsed.conversationRef).toEqual({
        serviceUrl: activity.serviceUrl,
        conversationId: activity.conversation.id,
        activityId: activity.id,
        replyToId: activity.replyToId,
      });
    }
  });

  it("rejects missing PR URL", async () => {
    const activity = JSON.parse(
      await readFile(join(fixturesDir, "activity-no-pr.json"), "utf8"),
    );
    const parsed = parseTeamsTrigger(activity);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("missing_pr_url");
    }
  });

  it("rejects missing ReviewBot mention", async () => {
    const activity = JSON.parse(
      await readFile(join(fixturesDir, "activity-no-mention.json"), "utf8"),
    );
    const parsed = parseTeamsTrigger(activity);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("missing_mention");
    }
  });

  it("uses sha256 conversation id and pr url when activity id is absent", () => {
    const activity = {
      type: "message",
      text: "@ReviewBot https://github.com/o/r/pull/7",
      serviceUrl: "https://sm.test",
      conversation: { id: "c1" },
    };
    const parsed = parseTeamsTrigger(activity);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.idempotencyKey).not.toBe("c1");
    }
  });

  it("rejects invalid activity shape", () => {
    expect(parseTeamsTrigger(null).ok).toBe(false);
    expect(parseTeamsTrigger({ type: "conversationUpdate" }).ok).toBe(false);
    if (!parseTeamsTrigger({ type: "conversationUpdate" }).ok) {
      expect(parseTeamsTrigger({ type: "conversationUpdate" }).code).toBe(
        "invalid_activity",
      );
    }
  });
});