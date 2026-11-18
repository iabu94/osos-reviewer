import { describe, expect, it, vi } from "vitest";
import { CARD_CONTENT_TYPE } from "../src/adaptive-card.js";
import {
  createFakeTeamsMessenger,
  createHttpTeamsMessenger,
  createPowerAutomateTeamsMessenger,
} from "../src/messenger.js";

describe("Teams messenger", () => {
  it("fake messenger records replies", async () => {
    const m = createFakeTeamsMessenger();
    await m.reply(
      { serviceUrl: "https://sm.test", conversationId: "c1" },
      { contentType: CARD_CONTENT_TYPE, content: { type: "AdaptiveCard" } },
    );
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]?.ref.conversationId).toBe("c1");
    expect(m.sent[0]?.card).toEqual({
      contentType: CARD_CONTENT_TYPE,
      content: { type: "AdaptiveCard" },
    });
  });

  it("http messenger posts activity with adaptive card attachment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      statusText: "Created",
    });
    const getToken = vi.fn().mockResolvedValue("fake-token");

    const messenger = createHttpTeamsMessenger({
      appId: "app-id",
      password: "pwd",
      fetchImpl: fetchImpl as typeof fetch,
      getToken,
    });

    await messenger.reply(
      {
        serviceUrl: "https://sm.test/",
        conversationId: "conv-1",
        replyToId: "parent-1",
      },
      { contentType: CARD_CONTENT_TYPE, content: { type: "AdaptiveCard" } },
    );

    expect(getToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://sm.test/v3/conversations/conv-1/activities",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer fake-token",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init?.body as string);
    expect(body.type).toBe("message");
    expect(body.replyToId).toBe("parent-1");
    expect(body.attachments).toEqual([
      {
        contentType: CARD_CONTENT_TYPE,
        content: { type: "AdaptiveCard" },
      },
    ]);
  });

  it("throws teams_delivery_failed on non-2xx reply", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
    });
    const messenger = createHttpTeamsMessenger({
      appId: "app-id",
      password: "pwd",
      fetchImpl: fetchImpl as typeof fetch,
      getToken: async () => "token",
    });

    await expect(
      messenger.reply(
        { serviceUrl: "https://sm.test", conversationId: "c1" },
        { contentType: CARD_CONTENT_TYPE, content: {} },
      ),
    ).rejects.toThrow(/teams_delivery_failed/);
  });

  it("Power Automate messenger posts card + conversation ref to flow URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      statusText: "Accepted",
    });
    const flowUrl = "https://prod-00.logic.azure.com/workflows/abc/triggers/manual/paths/invoke";
    const messenger = createPowerAutomateTeamsMessenger({
      flowUrl,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await messenger.reply(
      {
        serviceUrl: "https://sm.test",
        conversationId: "conv-1",
        activityId: "act-1",
        replyToId: "parent-1",
      },
      { contentType: CARD_CONTENT_TYPE, content: { type: "AdaptiveCard" } },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(flowUrl);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      serviceUrl: "https://sm.test",
      conversationId: "conv-1",
      activityId: "act-1",
      replyToId: "parent-1",
      contentType: CARD_CONTENT_TYPE,
      card: { type: "AdaptiveCard" },
      attachments: [
        {
          contentType: CARD_CONTENT_TYPE,
          content: { type: "AdaptiveCard" },
        },
      ],
    });
  });

  it("Power Automate messenger falls back replyToId to activityId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      statusText: "Accepted",
    });
    const messenger = createPowerAutomateTeamsMessenger({
      flowUrl: "https://example.com/flow",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await messenger.reply(
      {
        serviceUrl: "https://sm.test",
        conversationId: "conv-1",
        activityId: "act-1",
      },
      { contentType: CARD_CONTENT_TYPE, content: { type: "AdaptiveCard" } },
    );

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string);
    expect(body.replyToId).toBe("act-1");
    expect(body.attachments).toEqual([
      {
        contentType: CARD_CONTENT_TYPE,
        content: { type: "AdaptiveCard" },
      },
    ]);
  });

  it("Power Automate messenger throws teams_delivery_failed on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });
    const messenger = createPowerAutomateTeamsMessenger({
      flowUrl: "https://example.com/flow",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      messenger.reply(
        { serviceUrl: "https://sm.test", conversationId: "c1" },
        { contentType: CARD_CONTENT_TYPE, content: {} },
      ),
    ).rejects.toThrow(/teams_delivery_failed/);
  });
});