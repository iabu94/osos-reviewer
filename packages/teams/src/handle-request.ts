import { verifyTeamsRequest } from "./auth.js";
import { parseTeamsTrigger } from "./parse-trigger.js";
import type { TeamsWebhookLogger, TeamsWebhookWorker } from "./server.js";

export type TeamsHttpResult = {
  status: number;
  body: unknown;
};

export type TeamsHttpRequest = {
  method: string;
  path: string;
  headers: { signature?: string; authorization?: string };
  rawBody: Buffer;
};

export type HandleTeamsHttpRequestOpts = {
  secret: string;
  worker: TeamsWebhookWorker;
  logger?: TeamsWebhookLogger;
};

function noopLogger(): TeamsWebhookLogger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

export async function handleTeamsHttpRequest(
  req: TeamsHttpRequest,
  opts: HandleTeamsHttpRequestOpts,
): Promise<TeamsHttpResult> {
  const logger = opts.logger ?? noopLogger();

  try {
    if (req.method === "GET" && req.path === "/healthz") {
      return { status: 200, body: { ok: true } };
    }

    if (req.method === "POST" && req.path === "/teams-hook") {
      const auth = verifyTeamsRequest(
        req.rawBody,
        {
          signature: req.headers.signature,
          authorization: req.headers.authorization,
        },
        opts.secret,
      );
      if (!auth.ok) {
        return { status: 401, body: { error: "unauthorized" } };
      }

      let activity: unknown;
      try {
        activity = JSON.parse(req.rawBody.toString("utf8"));
      } catch {
        return {
          status: 400,
          body: {
            error: "invalid_activity",
            message: "Request body must be JSON",
          },
        };
      }

      const parsed = parseTeamsTrigger(activity);
      if (!parsed.ok) {
        return {
          status: 400,
          body: {
            error: parsed.code,
            message: parsed.message,
          },
        };
      }

      const { reviewId, duplicated } = await opts.worker.enqueue({
        prUrl: parsed.prUrl,
        idempotencyKey: parsed.idempotencyKey,
        teamsConversationRef: parsed.conversationRef,
      });

      logger.info("teams webhook accepted", {
        reviewId,
        duplicated,
        authMode: auth.mode,
      });

      if (auth.mode === "teams_hmac") {
        return {
          status: 200,
          body: {
            type: "message",
            text: duplicated
              ? `Review already in progress (${reviewId}). I'll post findings in this thread.`
              : `Review accepted (${reviewId}). I'll post findings in this thread.`,
          },
        };
      }

      return {
        status: 202,
        body: {
          reviewId,
          duplicated,
          status: "accepted",
        },
      };
    }

    return { status: 404, body: { error: "not_found" } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("teams webhook handler error", { err: message });
    return { status: 500, body: { error: "internal_error", message } };
  }
}
