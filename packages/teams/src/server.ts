import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { TeamsConversationRef } from "@review/shared";
import { handleTeamsHttpRequest } from "./handle-request.js";

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

export function createTeamsWebhookServer(
  opts: CreateTeamsWebhookServerOpts,
): Server {
  return createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = req.url?.split("?")[0] ?? "";
    const needsBody = method === "POST" && path === "/teams-hook";
    const rawBody = needsBody ? await readRawBody(req) : Buffer.alloc(0);

    const result = await handleTeamsHttpRequest(
      {
        method,
        path,
        headers: {
          signature: headerValue(req, "x-review-signature"),
          authorization: headerValue(req, "authorization"),
        },
        rawBody,
      },
      opts,
    );

    if (!res.headersSent) {
      sendJson(res, result.status, result.body);
    }
  });
}
