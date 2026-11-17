import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.js";

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes JSON with timestamp, level, and msg", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = createLogger({ reviewId: "r1" });
    log.info("started");
    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0]![0]);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("started");
    expect(parsed.reviewId).toBe("r1");
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("omits secret-looking field keys", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = createLogger();
    log.info("auth", {
      token: "secret-value",
      password: "pwd",
      authorization: "Bearer x",
      apiSecret: "s",
      safe: "ok",
    });
    const parsed = JSON.parse(String(spy.mock.calls[0]![0]).trimEnd());
    expect(parsed.safe).toBe("ok");
    expect(parsed.token).toBeUndefined();
    expect(parsed.password).toBeUndefined();
    expect(parsed.authorization).toBeUndefined();
    expect(parsed.apiSecret).toBeUndefined();
  });
});