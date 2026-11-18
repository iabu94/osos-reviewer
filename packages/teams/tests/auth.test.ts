import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyTeamsOutgoingHmac,
  verifyTeamsRequest,
  verifyTeamsSignature,
} from "../src/auth.js";

function hmacSha256Hex(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Teams security token is base64; HMAC key is the decoded bytes. */
const TEAMS_TOKEN = "vqF0En+Z0ucuRTM/01o2GuhMH3hKKk/N2bOmlM31zaA=";

function teamsHmacBase64(body: string, tokenBase64: string): string {
  const key = Buffer.from(tokenBase64, "base64");
  return createHmac("sha256", key).update(Buffer.from(body, "utf8")).digest("base64");
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

describe("verifyTeamsOutgoingHmac", () => {
  it("accepts Teams Authorization HMAC with base64-decoded security token", () => {
    const body = '{"type":"message","text":"hi"}';
    const digest = teamsHmacBase64(body, TEAMS_TOKEN);
    expect(
      verifyTeamsOutgoingHmac(body, `HMAC ${digest}`, TEAMS_TOKEN),
    ).toBe(true);
    expect(
      verifyTeamsOutgoingHmac(body, `HMAC wrong`, TEAMS_TOKEN),
    ).toBe(false);
  });

  it("returns false when Authorization is missing or wrong scheme", () => {
    const body = "{}";
    expect(verifyTeamsOutgoingHmac(body, undefined, TEAMS_TOKEN)).toBe(false);
    expect(verifyTeamsOutgoingHmac(body, "Bearer abc", TEAMS_TOKEN)).toBe(
      false,
    );
  });

  it("strips wrapping quotes from the security token", () => {
    const body = '{"ok":true}';
    const digest = teamsHmacBase64(body, TEAMS_TOKEN);
    expect(
      verifyTeamsOutgoingHmac(body, `HMAC ${digest}`, `"${TEAMS_TOKEN}"`),
    ).toBe(true);
  });
});

describe("verifyTeamsRequest", () => {
  it("accepts either Teams HMAC or custom review signature", () => {
    const body = '{"type":"message"}';
    const teamsDigest = teamsHmacBase64(body, TEAMS_TOKEN);
    expect(
      verifyTeamsRequest(
        body,
        { authorization: `HMAC ${teamsDigest}` },
        TEAMS_TOKEN,
      ),
    ).toEqual({ ok: true, mode: "teams_hmac" });

    const reviewSig = hmacSha256Hex(body, "sec");
    expect(
      verifyTeamsRequest(
        body,
        { signature: `sha256=${reviewSig}` },
        "sec",
      ),
    ).toEqual({ ok: true, mode: "review_signature" });

    expect(verifyTeamsRequest(body, {}, "sec")).toEqual({ ok: false });
  });
});
