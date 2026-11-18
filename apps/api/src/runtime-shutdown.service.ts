import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { TEAMS_RUNTIME_SHUTDOWN } from "./review-tokens.js";

@Injectable()
export class RuntimeShutdownService implements OnModuleDestroy {
  constructor(
    @Inject(TEAMS_RUNTIME_SHUTDOWN)
    private readonly shutdown: () => Promise<void>,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }
}
