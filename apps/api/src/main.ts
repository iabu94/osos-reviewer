import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createTeamsRuntime } from "@review/orchestrator";
import { RuntimeShutdownService } from "./runtime-shutdown.service.js";
import { TeamsController } from "./teams.controller.js";
import {
  TEAMS_RUNTIME_SHUTDOWN,
  TEAMS_WEBHOOK_LOGGER,
  TEAMS_WEBHOOK_SECRET,
  TEAMS_WEBHOOK_WORKER,
} from "./review-tokens.js";

async function bootstrap(): Promise<void> {
  const runtime = await createTeamsRuntime(process.env);

  @Module({
    controllers: [TeamsController],
    providers: [
      {
        provide: TEAMS_WEBHOOK_SECRET,
        useValue: runtime.config.teams.webhookSecret,
      },
      {
        provide: TEAMS_WEBHOOK_WORKER,
        useValue: runtime.worker,
      },
      {
        provide: TEAMS_WEBHOOK_LOGGER,
        useValue: runtime.logger,
      },
      {
        provide: TEAMS_RUNTIME_SHUTDOWN,
        useValue: runtime.shutdown,
      },
      RuntimeShutdownService,
    ],
  })
  class RuntimeModule {}

  const app = await NestFactory.create<NestExpressApplication>(RuntimeModule, {
    rawBody: true,
  });
  // Nest listens for SIGINT/SIGTERM and runs OnModuleDestroy → worker.drain + pool.end
  app.enableShutdownHooks();

  await app.listen(runtime.config.teams.port);
  runtime.logger.info("teams webhook listening", {
    port: runtime.config.teams.port,
    host: "nest",
  });
}

void bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
