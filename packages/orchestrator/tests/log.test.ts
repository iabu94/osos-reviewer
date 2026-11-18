import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.js";

describe("createLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes human-readable lines with timestamp, level, and msg", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = createLogger({ reviewId: "r1" });
    log.info("started");
    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0]![0]).trimEnd();
    expect(line).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO {2}started {2}reviewId=r1$/,
    );
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
    const line = String(spy.mock.calls[0]![0]).trimEnd();
    expect(line).toContain("safe=ok");
    expect(line).not.toContain("token=");
    expect(line).not.toContain("password=");
    expect(line).not.toContain("authorization=");
    expect(line).not.toContain("apiSecret=");
    expect(line).not.toContain("secret-value");
  });

  it("can omit base fields for a single call", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = createLogger({ component: "teams-webhook", reviewId: "r1" });
    log.info("review stage: claim worktree", undefined, { base: false });
    const line = String(spy.mock.calls[0]![0]).trimEnd();
    expect(line).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO {2}review stage: claim worktree$/,
    );
    expect(line).not.toContain("component=");
    expect(line).not.toContain("reviewId=");
  });
});
