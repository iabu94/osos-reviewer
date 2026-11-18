import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createTeamsRuntime } from "@review/orchestrator";
import { TeamsController } from "./teams.controller.js";
import {
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
    ],
  })
  class RuntimeModule {}

  const app = await NestFactory.create<NestExpressApplication>(RuntimeModule, {
    rawBody: true,
  });
  app.enableShutdownHooks();

  const shutdown = async (): Promise<void> => {
    try {
      await app.close();
    } finally {
      await runtime.shutdown();
    }
  };

  const onSignal = () => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

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
