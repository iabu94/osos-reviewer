import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";
const TEAMS_AUTH_PREFIX = /^HMAC\s+(\S+)\s*$/i;

function normalizeSecret(secret: string): string {
  const trimmed = secret.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/** Custom shared-secret header used by Power Automate / CLI smoke tests. */
export function verifyTeamsSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]+$/i.test(providedHex) || providedHex.length === 0) {
    return false;
  }

  const expectedHex = createHmac("sha256", normalizeSecret(secret))
    .update(rawBody)
    .digest("hex");

  return timingSafeEqualString(providedHex.toLowerCase(), expectedHex);
}

/**
 * Microsoft Teams Outgoing Webhook auth:
 * `Authorization: HMAC <base64(hmac-sha256(body, base64decode(securityToken)))>`
 */
export function verifyTeamsOutgoingHmac(
  rawBody: Buffer | string,
  authorizationHeader: string | undefined,
  securityTokenBase64: string,
): boolean {
  if (!authorizationHeader) {
    return false;
  }

  const match = authorizationHeader.match(TEAMS_AUTH_PREFIX);
  if (!match) {
    return false;
  }

  const provided = match[1];
  let key: Buffer;
  try {
    key = Buffer.from(normalizeSecret(securityTokenBase64), "base64");
  } catch {
    return false;
  }
  if (key.length === 0) {
    return false;
  }

  const body =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", key).update(body).digest("base64");
  return timingSafeEqualString(provided, expected);
}

/** Accept either Teams Outgoing Webhook HMAC or custom `x-review-signature`. */
export function verifyTeamsRequest(
  rawBody: Buffer | string,
  headers: {
    signature?: string;
    authorization?: string;
  },
  secret: string,
): { ok: true; mode: "teams_hmac" | "review_signature" } | { ok: false } {
  if (verifyTeamsOutgoingHmac(rawBody, headers.authorization, secret)) {
    return { ok: true, mode: "teams_hmac" };
  }
  if (verifyTeamsSignature(rawBody, headers.signature, secret)) {
    return { ok: true, mode: "review_signature" };
  }
  return { ok: false };
}
