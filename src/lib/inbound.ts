import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The receiving half of the bridge: verify NuCRM's deliveries and read their
 * envelope. The sending half is `dispatch.ts` + `sign.ts`, and the two schemes
 * are not the same one — deliberately documented rather than harmonised,
 * because the sender here is NuCRM and its signer is not ours to change.
 *
 * NuCRM signs `HMAC-SHA256(secret, rawBody)` — no timestamp in the key, unlike
 * `signDelivery` — and sends `sha256=<hex>` in `x-nucrm-signature`. Its own SDK
 * (`WebhookVerifier.verify`) compares the bare hex, so in the wild both the
 * prefixed and the bare form appear; the prefix is stripped here rather than
 * refused, because a receiver that demanded one form would fail every delivery
 * from the other code path and the failure would look like a wrong secret.
 */

/** Key prefix for this product, e.g. "in_live_". Visible in the string itself. */
export const INBOUND_SECRET_PREFIX = "in_live_";

/**
 * Mint the secret a sender signs with. Unlike an API key, the plaintext is
 * also what is stored — see the note on `InboundSource.secret` in the schema
 * for why hashing cannot work on this side of the bridge.
 */
export function generateInboundSecret(): { plaintext: string; prefix: string } {
  const plaintext = `${INBOUND_SECRET_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { plaintext, prefix: plaintext.slice(0, INBOUND_SECRET_PREFIX.length + 6) };
}

/**
 * Verify one delivery signature against the source's secret.
 *
 * Constant-time on the bytes, with every failure — no header, wrong length,
 * non-hex characters — answered `false` rather than thrown: a verifier that
 * throws on a hostile header is a 500 where the correct answer is a 401.
 */
export function verifyInboundSignature(
  secret: string,
  rawBody: string,
  header: string | null,
): boolean {
  if (!header) return false;
  const provided = (header.startsWith("sha256=") ? header.slice(7) : header).toLowerCase();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  // Same length in hex and in bytes, or there is nothing to compare: this also
  // rejects a truncated signature before `timingSafeEqual` could throw on it.
  if (provided.length !== expected.length) return false;
  const given = Buffer.from(provided, "hex");
  // `Buffer.from(hex)` stops at the first non-hex pair rather than throwing, so
  // "…zz" would compare as a shortened buffer and fail only on length. Say no here.
  if (given.length !== expected.length / 2) return false;
  return timingSafeEqual(given, Buffer.from(expected, "hex"));
}

/**
 * Parse a signed body into NuCRM's envelope shape, without reading fields —
 * `validateBody(…, INBOUND_NUCRM_EVENT)` does that, and it owns the 422s.
 *
 * This is only the layer the signature sits in front of: bytes that are not a
 * JSON object have no fields to name, which is a 400, not a 422. Both messages
 * are the ones `readJson` writes, so a sender sees one phrasing for one mistake
 * whether its body went through this path or a route's.
 */
export function parseInboundEnvelope(
  raw: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, message: "request body is not valid JSON" };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "request body must be a JSON object" };
  }
  return { ok: true, body: body as Record<string, unknown> };
}
