import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sign a webhook delivery: HMAC-SHA256 over `{timestamp}.{rawBody}`.
 *
 * Key discipline (deliberate): the server stores only the sha256 of the
 * secret, so it signs with that hash as the HMAC key — never a recoverable
 * secret. Receivers hold the plaintext and hash it first, then verify with
 * the same value. Both sides meet at sha256(secret) without it ever being
 * stored or transmitted. Pass the stored hash server-side, or
 * sha256(plaintext) receiver-side.
 */

export function signDelivery(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyDelivery(secret: string, rawBody: string, timestamp: string, signature: string): boolean {
  const expected = Buffer.from(signDelivery(secret, timestamp, rawBody));
  const actual = Buffer.from(signature ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
