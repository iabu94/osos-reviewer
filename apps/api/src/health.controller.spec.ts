import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { HealthController } from "./health.controller.js";

describe("HealthController", () => {
  it("GET healthz returns { ok: true }", async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    const controller = mod.get(HealthController);
    expect(controller.healthz()).toEqual({ ok: true });
  });
});
