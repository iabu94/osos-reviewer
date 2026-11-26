import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { createTeamsWebhookServer } from "@osos-reviewer/teams";
import { createTeamsRuntime } from "./teams-runtime.js";

export async function startTeamsWebhookCli(
  env: NodeJS.ProcessEnv,
): Promise<{ server: Server; shutdown: () => Promise<void> }> {
  const runtime = await createTeamsRuntime(env);

  const server = createTeamsWebhookServer({
    secret: runtime.config.teams.webhookSecret,
    worker: runtime.worker,
    logger: runtime.logger,
  });

  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await runtime.shutdown();
  };

  await new Promise<void>((resolve, reject) => {
    server.listen(runtime.config.teams.port, () => {
      runtime.logger.info("teams webhook listening", {
        port: runtime.config.teams.port,
      });
      resolve();
    });
    server.on("error", reject);
  });

  return { server, shutdown };
}

async function main(): Promise<void> {
  const { shutdown } = await startTeamsWebhookCli(process.env);

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
}

const entry = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (entry && import.meta.url === entry) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
