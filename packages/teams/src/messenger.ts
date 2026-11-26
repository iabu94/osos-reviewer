import type { TeamsConversationRef } from "@osos-reviewer/shared";

export type TeamsMessenger = {
  reply(
    ref: TeamsConversationRef,
    card: { contentType: string; content: unknown },
  ): Promise<void>;
};

export function createFakeTeamsMessenger(): TeamsMessenger & {
  sent: Array<{ ref: TeamsConversationRef; card: unknown }>;
} {
  const sent: Array<{ ref: TeamsConversationRef; card: unknown }> = [];

  return {
    sent,
    async reply(
      ref: TeamsConversationRef,
      card: { contentType: string; content: unknown },
    ): Promise<void> {
      sent.push({ ref, card });
    },
  };
}

function activitiesUrl(serviceUrl: string, conversationId: string): string {
  const base = serviceUrl.endsWith("/") ? serviceUrl.slice(0, -1) : serviceUrl;
  return `${base}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
}

async function defaultGetToken(
  appId: string,
  password: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: appId,
    client_secret: password,
    scope: "https://api.botframework.com/.default",
  });

  const res = await fetchImpl(
    "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );

  if (!res.ok) {
    throw new Error(
      `teams_delivery_failed: token request failed with status ${res.status}`,
    );
  }

  const json = (await res.json()) as { access_token?: string };
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error("teams_delivery_failed: token response missing access_token");
  }

  return json.access_token;
}

export function createHttpTeamsMessenger(opts: {
  appId: string;
  password: string;
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string>;
}): TeamsMessenger {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolveToken =
    opts.getToken ??
    (() => defaultGetToken(opts.appId, opts.password, fetchImpl));

  return {
    async reply(
      ref: TeamsConversationRef,
      card: { contentType: string; content: unknown },
    ): Promise<void> {
      const token = await resolveToken();

      const activity: Record<string, unknown> = {
        type: "message",
        attachments: [
          {
            contentType: card.contentType,
            content: card.content,
          },
        ],
      };

      if (ref.replyToId !== undefined) {
        activity.replyToId = ref.replyToId;
      }

      const res = await fetchImpl(
        activitiesUrl(ref.serviceUrl, ref.conversationId),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(activity),
        },
      );

      if (!res.ok) {
        throw new Error(
          `teams_delivery_failed: reply failed with status ${res.status} ${res.statusText}`,
        );
      }
    },
  };
}

/**
 * Posts Adaptive Card replies to a Power Automate HTTP trigger.
 *
 * Body shape for PA mapping:
 *   parentMessageId ← replyToId (falls back to activityId for top-level @mentions)
 *   For each attachments → messageBody ← item()?['content']
 *   (card / contentType kept for direct triggerBody mappings)
 */
export function createPowerAutomateTeamsMessenger(opts: {
  flowUrl: string;
  fetchImpl?: typeof fetch;
}): TeamsMessenger {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const flowUrl = opts.flowUrl;

  return {
    async reply(
      ref: TeamsConversationRef,
      card: { contentType: string; content: unknown },
    ): Promise<void> {
      const replyToId = ref.replyToId ?? ref.activityId;
      const attachment = {
        contentType: card.contentType,
        content: card.content,
      };
      const body = {
        serviceUrl: ref.serviceUrl,
        conversationId: ref.conversationId,
        activityId: ref.activityId,
        replyToId,
        contentType: card.contentType,
        card: card.content,
        attachments: [attachment],
      };

      const res = await fetchImpl(flowUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(
          `teams_delivery_failed: Power Automate reply failed with status ${res.status} ${res.statusText}`,
        );
      }
    },
  };
}