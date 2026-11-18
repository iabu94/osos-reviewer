import {
  Controller,
  Get,
  Header,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request, Response } from "express";
import {
  handleTeamsHttpRequest,
  type TeamsWebhookWorker,
} from "@review/teams";
import {
  TEAMS_WEBHOOK_SECRET,
  TEAMS_WEBHOOK_WORKER,
} from "./review-tokens.js";

@Controller()
export class TeamsController {
  constructor(
    @Inject(TEAMS_WEBHOOK_SECRET) private readonly secret: string,
    @Inject(TEAMS_WEBHOOK_WORKER)
    private readonly worker: TeamsWebhookWorker,
  ) {}

  @Get("healthz")
  async healthz(
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const result = await handleTeamsHttpRequest(
      {
        method: "GET",
        path: "/healthz",
        headers: {},
        rawBody: Buffer.alloc(0),
      },
      { secret: this.secret, worker: this.worker },
    );
    res.status(result.status).json(result.body);
  }

  @Post("teams-hook")
  @Header("content-type", "application/json; charset=utf-8")
  async teamsHook(
    @Req() req: RawBodyRequest<Request>,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const result = await handleTeamsHttpRequest(
      {
        method: "POST",
        path: "/teams-hook",
        headers: {
          signature: header(req, "x-review-signature"),
          authorization: header(req, "authorization"),
        },
        rawBody,
      },
      { secret: this.secret, worker: this.worker },
    );
    res.status(result.status).json(result.body);
  }
}

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}
