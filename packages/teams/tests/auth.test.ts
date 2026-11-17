import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyTeamsSignature } from "../src/auth.js";

function hmacSha256Hex(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyTeamsSignature", () => {
  it("accepts valid HMAC signature", () => {
    const body = '{"type":"message"}';
    const sig = hmacSha256Hex(body, "sec");
    expect(verifyTeamsSignature(body, `sha256=${sig}`, "sec")).toBe(true);
    expect(verifyTeamsSignature(body, "sha256=dead", "sec")).toBe(false);
  });

  it("returns false when signature header is missing", () => {
    expect(verifyTeamsSignature('{"type":"message"}', undefined, "sec")).toBe(
      false,
    );
  });

  it("returns false when header is malformed", () => {
    const body = '{"type":"message"}';
    const sig = hmacSha256Hex(body, "sec");
    expect(verifyTeamsSignature(body, sig, "sec")).toBe(false);
    expect(verifyTeamsSignature(body, "sha256=", "sec")).toBe(false);
  });
});