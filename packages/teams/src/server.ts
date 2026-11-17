import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { TeamsConversationRef } from "@review/shared";
import { verifyTeamsSignature } from "./auth.js";
import { parseTeamsTrigger } from "./parse-trigger.js";

export type TeamsWebhookLogger = {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
};

export type TeamsWebhookEnqueueInput = {
  prUrl: string;
  idempotencyKey: string;
  teamsConversationRef: TeamsConversationRef;
  reviewId?: string;
};

export type TeamsWebhookWorker = {
  enqueue: (
    input: TeamsWebhookEnqueueInput,
  ) => Promise<{ reviewId: string; duplicated: boolean }>;
  drain?: () => Promise<void>;
};

export type CreateTeamsWebhookServerOpts = {
  secret: string;
  worker: TeamsWebhookWorker;
  logger?: TeamsWebhookLogger;
};

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function headerValue(
  req: IncomingMessage,
  name: string,
): string | undefined {
  const key = name.toLowerCase();
  const raw = req.headers[key];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function noopLogger(): TeamsWebhookLogger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

export function createTeamsWebhookServer(
  opts: CreateTeamsWebhookServerOpts,
): Server {
  const logger = opts.logger ?? noopLogger();

  return createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const path = req.url?.split("?")[0] ?? "";

      if (method === "GET" && path === "/healthz") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && path === "/hooks/teams") {
        const rawBody = await readRawBody(req);
        const signature = headerValue(req, "x-review-signature");
        if (!verifyTeamsSignature(rawBody, signature, opts.secret)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        let activity: unknown;
        try {
          activity = JSON.parse(rawBody.toString("utf8"));
        } catch {
          sendJson(res, 400, {
            error: "invalid_activity",
            message: "Request body must be JSON",
          });
          return;
        }

        const parsed = parseTeamsTrigger(activity);
        if (!parsed.ok) {
          sendJson(res, 400, {
            error: parsed.code,
            message: parsed.message,
          });
          return;
        }

        const { reviewId, duplicated } = await opts.worker.enqueue({
          prUrl: parsed.prUrl,
          idempotencyKey: parsed.idempotencyKey,
          teamsConversationRef: parsed.conversationRef,
        });

        logger.info("teams webhook accepted", { reviewId, duplicated });
        sendJson(res, 202, {
          reviewId,
          duplicated,
          status: "accepted",
        });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("teams webhook handler error", { err: message });
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error", message });
      }
    }
  });
}