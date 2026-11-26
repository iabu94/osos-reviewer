import { createHash } from "node:crypto";
import type { TeamsConversationRef } from "@osos-reviewer/shared";

/**
 * Matches `@ReviewBot`, Teams `<at>ReviewBot</at>`, or any `<at>…</at>`.
 * Outgoing Webhooks only fire when their configured name is @mentioned, so any
 * `<at>` tag is a sufficient mention signal.
 */
const MENTION_RE =
  /(?:^|[\s>])@?ReviewBot\b|<at[^>]*>\s*[^<]+?\s*<\/at>/i;
const PR_URL_RE = /https?:\/\/[^\s"'<>]+\/pull\/\d+/;

export type ParseTeamsTriggerResult =
  | {
      ok: true;
      prUrl: string;
      idempotencyKey: string;
      conversationRef: TeamsConversationRef;
    }
  | {
      ok: false;
      code: "missing_mention" | "missing_pr_url" | "invalid_activity";
      message: string;
    };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractSearchableText(activity: Record<string, unknown>): string {
  const parts: string[] = [];

  if (typeof activity.text === "string") {
    parts.push(activity.text);
  }

  const attachments = activity.attachments;
  if (Array.isArray(attachments)) {
    for (const item of attachments) {
      if (!isRecord(item)) continue;
      const content = item.content;
      if (typeof content === "string") {
        parts.push(content);
      } else if (content !== undefined) {
        parts.push(JSON.stringify(content));
      }
    }
  }

  return parts.join(" ");
}

export function parseTeamsTrigger(activity: unknown): ParseTeamsTriggerResult {
  if (!isRecord(activity)) {
    return {
      ok: false,
      code: "invalid_activity",
      message: "Activity must be an object",
    };
  }

  if (activity.type !== "message") {
    return {
      ok: false,
      code: "invalid_activity",
      message: 'Activity type must be "message"',
    };
  }

  const serviceUrl = activity.serviceUrl;
  if (typeof serviceUrl !== "string" || serviceUrl.length === 0) {
    return {
      ok: false,
      code: "invalid_activity",
      message: "Activity serviceUrl is required",
    };
  }

  const conversation = activity.conversation;
  if (!isRecord(conversation) || typeof conversation.id !== "string") {
    return {
      ok: false,
      code: "invalid_activity",
      message: "Activity conversation.id is required",
    };
  }

  const text = extractSearchableText(activity);

  if (!MENTION_RE.test(text)) {
    return {
      ok: false,
      code: "missing_mention",
      message: "ReviewBot mention is required",
    };
  }

  const prMatch = text.match(PR_URL_RE);
  if (!prMatch) {
    return {
      ok: false,
      code: "missing_pr_url",
      message: "GitHub pull request URL is required",
    };
  }

  const prUrl = prMatch[0];

  const activityId =
    typeof activity.id === "string" && activity.id.length > 0
      ? activity.id
      : undefined;

  const idempotencyKey =
    activityId ?? sha256(`${conversation.id}:${prUrl}`);

  const conversationRef: TeamsConversationRef = {
    serviceUrl,
    conversationId: conversation.id,
  };

  if (activityId !== undefined) {
    conversationRef.activityId = activityId;
  }

  if (typeof activity.replyToId === "string") {
    conversationRef.replyToId = activity.replyToId;
  }

  return {
    ok: true,
    prUrl,
    idempotencyKey,
    conversationRef,
  };
}