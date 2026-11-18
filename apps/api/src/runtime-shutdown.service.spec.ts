import { describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { RuntimeShutdownService } from "./runtime-shutdown.service.js";
import { TEAMS_RUNTIME_SHUTDOWN } from "./review-tokens.js";

describe("RuntimeShutdownService", () => {
  it("onModuleDestroy calls injected runtime shutdown", async () => {
    const shutdown = vi.fn(async () => undefined);
    const mod = await Test.createTestingModule({
      providers: [
        RuntimeShutdownService,
        { provide: TEAMS_RUNTIME_SHUTDOWN, useValue: shutdown },
      ],
    }).compile();
    const service = mod.get(RuntimeShutdownService);
    await service.onModuleDestroy();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
